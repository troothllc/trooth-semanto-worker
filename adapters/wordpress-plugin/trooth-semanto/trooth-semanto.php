<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Semanto by Trooth for WordPress: serves the signed copy of this site's pages
// as markdown and JSON-LD, and the Trooth files under /.well-known, from the
// company's own domain; adds the alternate link and the facts block to <head>;
// sends WooCommerce product data to Trooth, signed. Plain PHP, no Composer.
// Plugin structure follows the WordPress Plugin Handbook
// (developer.wordpress.org/plugins/plugin-basics/).
/**
 * Plugin Name:       Trooth Semanto
 * Plugin URI:        https://trooth.co/semanto
 * Description:       Your whole public website in one signed file, served from your own domain to people and agents. Markdown and JSON-LD on request, the /.well-known files, and WooCommerce product data to Trooth.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            Trooth, LLC
 * Author URI:        https://trooth.co
 * License:           LicenseRef-Trooth-Proprietary
 * Text Domain:       trooth-semanto
 * WC requires at least: 8.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'TROOTH_SEMANTO_VERSION', '0.1.0' );
define( 'TROOTH_SEMANTO_FILE', __FILE__ );
define( 'TROOTH_SEMANTO_DIR', plugin_dir_path( __FILE__ ) );

require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-negotiate.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-client.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-serve.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-head.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-signer.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-woocommerce.php';
require_once TROOTH_SEMANTO_DIR . 'includes/class-trooth-semanto-settings.php';

/** The three settings, read once. @return array{trooth_id:string,mode:string,api_base:string} */
function trooth_semanto_settings(): array {
	return array(
		'trooth_id' => (string) get_option( 'trooth_semanto_trooth_id', '' ),
		'mode'      => Trooth_Semanto_Negotiate::normalize_mode( get_option( 'trooth_semanto_mode', 'semanto_only' ) ),
		'api_base'  => rtrim( (string) get_option( 'trooth_semanto_api_base', 'https://api.trooth.co' ), '/' ),
	);
}

function trooth_semanto_client(): Trooth_Semanto_Client {
	static $client = null;
	if ( null === $client ) {
		$s      = trooth_semanto_settings();
		$client = new Trooth_Semanto_Client( $s['api_base'] . '/public/semanto/' . rawurlencode( $s['trooth_id'] ) );
	}
	return $client;
}

function trooth_semanto_boot(): void {
	$s = trooth_semanto_settings();
	( new Trooth_Semanto_Settings() )->register();
	if ( '' === $s['trooth_id'] ) {
		add_action(
			'admin_notices',
			static function () {
				if ( current_user_can( 'manage_options' ) ) {
					echo '<div class="notice notice-info"><p>Trooth Semanto is active but has no Trooth ID yet. <a href="' . esc_url( admin_url( 'options-general.php?page=trooth-semanto' ) ) . '">Enter it here.</a></p></div>';
				}
			}
		);
		return;
	}
	$client = trooth_semanto_client();
	( new Trooth_Semanto_Serve( $client, $s['mode'] ) )->register();
	( new Trooth_Semanto_Head( $client, $s['mode'] ) )->register();
	( new Trooth_Semanto_WooCommerce( $s['api_base'], $s['trooth_id'] ) )->register();
}
add_action( 'plugins_loaded', 'trooth_semanto_boot' );

// WooCommerce High-Performance Order Storage: this plugin touches products only, so it is compatible.
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

register_activation_hook(
	__FILE__,
	static function () {
		add_option( 'trooth_semanto_mode', 'semanto_only' );
		add_option( 'trooth_semanto_api_base', 'https://api.trooth.co' );
		// Make the connector key now, so the settings page can show it at once.
		if ( Trooth_Semanto_Signer::available() ) {
			Trooth_Semanto_Signer::key();
		}
	}
);

register_deactivation_hook(
	__FILE__,
	static function () {
		wp_clear_scheduled_hook( Trooth_Semanto_WooCommerce::CRON_HOOK );
		Trooth_Semanto_Client::flush();
	}
);
