<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// WooCommerce: when a product or variation changes, collect the catalog
// (sku, GTIN from _global_unique_id, price, stock status, per product and per
// variation) and POST it, signed, to the Trooth API so the commerce records
// can be built. The POST is debounced through WP-Cron so a bulk edit sends one
// document. Fields follow WooCommerce's product data model (WC_Product and
// WC_Product_Variation, WooCommerce 9.2 and later for get_global_unique_id)
// and the schema.org Product and Offer vocabulary the API maps them to.
//
// Endpoint (built on the API side):
//   POST {TROOTH_API_BASE}/os/semanto/{trooth_id}/commerce/catalog
//   Content-Type: application/json, signed per class-trooth-semanto-signer.php
//   Body: see build_document(). The API answers 202 and a receipt id.

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_WooCommerce {

	const CRON_HOOK = 'trooth_semanto_sync_products';
	const LOCK      = 'trooth_semanto_sync_pending';
	const LAST      = 'trooth_semanto_last_sync';

	private string $api_base;
	private string $trooth_id;

	public function __construct( string $api_base, string $trooth_id ) {
		$this->api_base  = rtrim( $api_base, '/' );
		$this->trooth_id = $trooth_id;
	}

	public static function active(): bool {
		return class_exists( 'WooCommerce' ) && function_exists( 'wc_get_products' );
	}

	public function endpoint(): string {
		return $this->api_base . '/os/semanto/' . rawurlencode( $this->trooth_id ) . '/commerce/catalog';
	}

	public function register(): void {
		if ( ! self::active() ) {
			return;
		}
		foreach ( array( 'woocommerce_new_product', 'woocommerce_update_product', 'woocommerce_new_product_variation', 'woocommerce_update_product_variation', 'woocommerce_product_set_stock_status', 'woocommerce_variation_set_stock_status', 'woocommerce_product_set_stock', 'woocommerce_variation_set_stock', 'woocommerce_delete_product', 'woocommerce_trash_product' ) as $hook ) {
			add_action( $hook, array( $this, 'schedule' ), 10, 0 );
		}
		add_action( self::CRON_HOOK, array( $this, 'sync' ) );
	}

	/** One send per minute at most, whatever changed. */
	public function schedule(): void {
		if ( get_transient( self::LOCK ) ) {
			return;
		}
		set_transient( self::LOCK, 1, MINUTE_IN_SECONDS );
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_single_event( time() + 60, self::CRON_HOOK );
		}
	}

	/** @return array<string,mixed> The document the API receives. */
	public function build_document(): array {
		$products = array();
		$page     = 1;
		do {
			$batch = wc_get_products(
				array(
					'status'   => 'publish',
					'limit'    => 100,
					'page'     => $page,
					'orderby'  => 'ID',
					'order'    => 'ASC',
					'paginate' => false,
				)
			);
			foreach ( $batch as $product ) {
				$products[] = $this->product_record( $product );
			}
			++$page;
		} while ( count( $batch ) === 100 );

		return array(
			'source'       => 'woocommerce',
			'site'         => home_url( '/' ),
			'trooth_id'    => $this->trooth_id,
			'currency'     => get_woocommerce_currency(),
			'generated_at' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'plugin'       => 'trooth-semanto/' . TROOTH_SEMANTO_VERSION,
			'products'     => $products,
		);
	}

	private function gtin( WC_Product $p ): ?string {
		$g = method_exists( $p, 'get_global_unique_id' ) ? (string) $p->get_global_unique_id() : (string) $p->get_meta( '_global_unique_id', true );
		$g = preg_replace( '/[^0-9]/', '', $g );
		return '' === $g ? null : $g;
	}

	/** @return array<string,mixed> */
	private function product_record( WC_Product $p ): array {
		$record = array(
			'id'            => (string) $p->get_id(),
			'type'          => $p->get_type(),
			'name'          => $p->get_name(),
			'url'           => $p->get_permalink(),
			'sku'           => (string) $p->get_sku(),
			'gtin'          => $this->gtin( $p ),
			'price'         => '' === $p->get_price() ? null : (string) $p->get_price(),
			'regular_price' => '' === $p->get_regular_price() ? null : (string) $p->get_regular_price(),
			'sale_price'    => '' === $p->get_sale_price() ? null : (string) $p->get_sale_price(),
			'stock_status'  => $p->get_stock_status(),
			'stock'         => $p->managing_stock() ? $p->get_stock_quantity() : null,
			'modified_at'   => $p->get_date_modified() ? $p->get_date_modified()->date( 'Y-m-d\TH:i:s\Z' ) : null,
			'variants'      => array(),
		);
		if ( $p->is_type( 'variable' ) ) {
			foreach ( $p->get_children() as $child_id ) {
				$v = wc_get_product( $child_id );
				if ( ! $v instanceof WC_Product_Variation ) {
					continue;
				}
				$record['variants'][] = array(
					'id'           => (string) $v->get_id(),
					'sku'          => (string) $v->get_sku(),
					'gtin'         => $this->gtin( $v ),
					'price'        => '' === $v->get_price() ? null : (string) $v->get_price(),
					'stock_status' => $v->get_stock_status(),
					'stock'        => $v->managing_stock() ? $v->get_stock_quantity() : null,
					'attributes'   => $v->get_attributes(),
					'url'          => $v->get_permalink(),
				);
			}
		}
		return $record;
	}

	/** Build, sign and send. Returns what happened, in plain words, for the settings page. */
	public function sync(): string {
		delete_transient( self::LOCK );
		if ( '' === $this->trooth_id ) {
			return 'No Trooth ID is set, so nothing was sent.';
		}
		$doc = $this->build_document();
		$res = Trooth_Semanto_Signer::post_json( $this->endpoint(), $doc );
		if ( is_wp_error( $res ) ) {
			$msg = 'Sending failed: ' . $res->get_error_message();
		} else {
			$code = (int) wp_remote_retrieve_response_code( $res );
			$msg  = ( $code >= 200 && $code < 300 )
				? sprintf( 'Sent %d products to Trooth (answer %d).', count( $doc['products'] ), $code )
				: sprintf( 'Trooth answered %d. The key on the settings page may not be registered yet.', $code );
		}
		update_option( self::LAST, array( 'at' => gmdate( 'c' ), 'message' => $msg, 'count' => count( $doc['products'] ) ), false );
		return $msg;
	}
}
