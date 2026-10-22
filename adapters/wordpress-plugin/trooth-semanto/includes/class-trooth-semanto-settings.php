<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The settings page under Settings, Trooth Semanto: Trooth ID, mode, the API
// address, the connector public key to paste into the Trooth dashboard, and
// three buttons (check the connection, clear the cache, send products now).
// Uses the WordPress Settings API (developer.wordpress.org/plugins/settings/)
// and admin-post actions with nonces for the buttons. Plain words throughout.

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_Settings {

	const GROUP = 'trooth_semanto';
	const PAGE  = 'trooth-semanto';

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_init', array( $this, 'fields' ) );
		add_action( 'admin_post_trooth_semanto_flush', array( $this, 'action_flush' ) );
		add_action( 'admin_post_trooth_semanto_sync', array( $this, 'action_sync' ) );
		add_action( 'admin_post_trooth_semanto_rotate', array( $this, 'action_rotate' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( TROOTH_SEMANTO_FILE ), array( $this, 'action_links' ) );
	}

	public function action_links( array $links ): array {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'trooth-semanto' ) . '</a>' );
		return $links;
	}

	public function menu(): void {
		add_options_page( 'Trooth Semanto', 'Trooth Semanto', 'manage_options', self::PAGE, array( $this, 'render' ) );
	}

	public function fields(): void {
		register_setting( self::GROUP, 'trooth_semanto_trooth_id', array( 'type' => 'string', 'sanitize_callback' => array( $this, 'sanitize_trooth_id' ), 'default' => '' ) );
		register_setting( self::GROUP, 'trooth_semanto_mode', array( 'type' => 'string', 'sanitize_callback' => array( 'Trooth_Semanto_Negotiate', 'normalize_mode' ), 'default' => 'semanto_only' ) );
		register_setting( self::GROUP, 'trooth_semanto_api_base', array( 'type' => 'string', 'sanitize_callback' => array( $this, 'sanitize_api_base' ), 'default' => 'https://api.trooth.co' ) );

		add_settings_section( 'main', '', '__return_false', self::PAGE );
		add_settings_field( 'trooth_id', 'Trooth ID', array( $this, 'field_trooth_id' ), self::PAGE, 'main' );
		add_settings_field( 'mode', 'What this plugin serves', array( $this, 'field_mode' ), self::PAGE, 'main' );
		add_settings_field( 'api_base', 'Trooth API address', array( $this, 'field_api_base' ), self::PAGE, 'main' );
	}

	public function sanitize_trooth_id( $v ): string {
		$v = strtolower( trim( (string) $v ) );
		if ( '' !== $v && ! preg_match( '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/', $v ) ) {
			add_settings_error( 'trooth_semanto_trooth_id', 'bad', 'A Trooth ID has lowercase letters, digits and hyphens only. Copy it from your Trooth dashboard.' );
			return (string) get_option( 'trooth_semanto_trooth_id', '' );
		}
		Trooth_Semanto_Client::flush();
		return $v;
	}

	public function sanitize_api_base( $v ): string {
		$v = rtrim( trim( (string) $v ), '/' );
		if ( '' === $v ) {
			return 'https://api.trooth.co';
		}
		if ( 0 !== strpos( $v, 'https://' ) ) {
			add_settings_error( 'trooth_semanto_api_base', 'bad', 'The API address must start with https://' );
			return (string) get_option( 'trooth_semanto_api_base', 'https://api.trooth.co' );
		}
		return esc_url_raw( $v );
	}

	public function field_trooth_id(): void {
		printf( '<input type="text" class="regular-text code" name="trooth_semanto_trooth_id" value="%s" placeholder="example-inc">', esc_attr( get_option( 'trooth_semanto_trooth_id', '' ) ) );
		echo '<p class="description">Shown on your Trooth dashboard. The plugin serves the signed copy Trooth holds under this ID.</p>';
	}

	public function field_mode(): void {
		$mode  = Trooth_Semanto_Negotiate::normalize_mode( get_option( 'trooth_semanto_mode', 'semanto_only' ) );
		$modes = array(
			'semanto_only'                          => 'Signed copy for every markdown and JSON-LD request (recommended). A page Trooth has not signed gets a short "not found" page, never an unsigned conversion.',
			'semanto_then_cloudflare_for_unsigned'  => 'Signed copy for the pages in your current Semanto only. Other markdown requests go to your site (or to Cloudflare, if it converts pages for you).',
			'proof_only'                            => 'Only the two files under /.well-known and the headers on your HTML. Markdown is left to your site.',
		);
		foreach ( $modes as $value => $label ) {
			printf( '<label style="display:block;margin-bottom:8px"><input type="radio" name="trooth_semanto_mode" value="%s" %s> <code>%s</code><br><span class="description">%s</span></label>', esc_attr( $value ), checked( $mode, $value, false ), esc_html( $value ), esc_html( $label ) );
		}
	}

	public function field_api_base(): void {
		printf( '<input type="url" class="regular-text code" name="trooth_semanto_api_base" value="%s">', esc_attr( get_option( 'trooth_semanto_api_base', 'https://api.trooth.co' ) ) );
		echo '<p class="description">Leave this as it is unless Trooth tells you otherwise.</p>';
	}

	private function check_connection( Trooth_Semanto_Client $client ): string {
		$manifest = $client->manifest();
		if ( null === $manifest ) {
			return 'Trooth did not answer for this ID yet. Check the ID, or publish your Semanto on the dashboard first.';
		}
		$pages   = count( Trooth_Semanto_Negotiate::pages_of( $manifest ) );
		$version = Trooth_Semanto_Negotiate::manifest_version( $manifest ) ?? '?';
		return sprintf( 'Connected. Version %s of your Semanto lists %d pages.', $version, $pages );
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$trooth_id = (string) get_option( 'trooth_semanto_trooth_id', '' );
		$client    = trooth_semanto_client();
		$notice    = isset( $_GET['trooth_notice'] ) ? sanitize_text_field( wp_unslash( $_GET['trooth_notice'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
		echo '<div class="wrap"><h1>Trooth Semanto</h1>';
		echo '<p>Your site keeps working as it does. When a reader asks for a page as markdown or JSON-LD, or for the Trooth files under /.well-known, this plugin answers with the signed copy Trooth holds for you, byte for byte, with its signature headers. The decision is made on the Accept header and the path, never on who the reader is.</p>';
		if ( '' !== $notice ) {
			echo '<div class="notice notice-info"><p>' . esc_html( $notice ) . '</p></div>';
		}
		settings_errors();
		echo '<form method="post" action="options.php">';
		settings_fields( self::GROUP );
		do_settings_sections( self::PAGE );
		submit_button( 'Save' );
		echo '</form>';

		echo '<h2>Status</h2>';
		if ( '' === $trooth_id ) {
			echo '<p>Enter your Trooth ID above to connect.</p>';
		} else {
			echo '<p>' . esc_html( $this->check_connection( $client ) ) . '</p>';
			echo '<p>Check from the outside: <code>curl -sI ' . esc_html( home_url( '/.well-known/trooth.semanto' ) ) . '</code> should show a <code>Signature</code> header.</p>';
		}
		$this->button( 'trooth_semanto_flush', 'Clear the cache', 'Fetch fresh copies from Trooth on the next request.' );

		echo '<h2>Products (WooCommerce)</h2>';
		if ( ! Trooth_Semanto_WooCommerce::active() ) {
			echo '<p>WooCommerce is not active on this site. Nothing to send.</p>';
		} else {
			echo '<p>When a product or variation changes, the plugin sends your catalog (name, SKU, GTIN, price, stock status, per variation) to Trooth, signed with a key made on this site, so your product records can be built and kept current. Nothing about customers or orders is sent.</p>';
			$jwk = Trooth_Semanto_Signer::public_jwk();
			if ( null === $jwk ) {
				echo '<p>This server has no sodium extension, so the plugin cannot sign. Ask your host to enable it (PHP 7.2 and later ship it).</p>';
			} else {
				echo '<p>Paste this public key into your Trooth dashboard under Delivery, Connectors, WooCommerce, once:</p>';
				echo '<textarea class="large-text code" rows="3" readonly>' . esc_textarea( wp_json_encode( $jwk ) ) . '</textarea>';
				$last = get_option( Trooth_Semanto_WooCommerce::LAST );
				if ( is_array( $last ) ) {
					echo '<p>Last send: ' . esc_html( $last['at'] ) . '. ' . esc_html( $last['message'] ) . '</p>';
				}
				$this->button( 'trooth_semanto_sync', 'Send products now', '' );
				$this->button( 'trooth_semanto_rotate', 'Make a new key', 'The old key stops working once you paste the new one into the dashboard.' );
			}
			$wc = new Trooth_Semanto_WooCommerce( (string) get_option( 'trooth_semanto_api_base', 'https://api.trooth.co' ), $trooth_id );
			echo '<p class="description">Endpoint: <code>POST ' . esc_html( $wc->endpoint() ) . '</code>, signed per RFC 9421 with a Content-Digest.</p>';
		}
		echo '</div>';
	}

	private function button( string $action, string $label, string $help ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline-block;margin-right:12px">';
		echo '<input type="hidden" name="action" value="' . esc_attr( $action ) . '">';
		wp_nonce_field( $action );
		submit_button( $label, 'secondary', 'submit', false );
		if ( '' !== $help ) {
			echo ' <span class="description">' . esc_html( $help ) . '</span>';
		}
		echo '</form>';
	}

	private function back( string $notice ): void {
		wp_safe_redirect( add_query_arg( array( 'page' => self::PAGE, 'trooth_notice' => rawurlencode( $notice ) ), admin_url( 'options-general.php' ) ) );
		exit;
	}

	public function action_flush(): void {
		check_admin_referer( 'trooth_semanto_flush' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed.' );
		}
		Trooth_Semanto_Client::flush();
		$this->back( 'Cache cleared.' );
	}

	public function action_sync(): void {
		check_admin_referer( 'trooth_semanto_sync' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed.' );
		}
		$wc = new Trooth_Semanto_WooCommerce( (string) get_option( 'trooth_semanto_api_base', 'https://api.trooth.co' ), (string) get_option( 'trooth_semanto_trooth_id', '' ) );
		$this->back( $wc->sync() );
	}

	public function action_rotate(): void {
		check_admin_referer( 'trooth_semanto_rotate' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed.' );
		}
		Trooth_Semanto_Signer::rotate();
		$this->back( 'A new key was made. Paste the new public key into the Trooth dashboard.' );
	}
}
