<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Runs when the plugin is deleted from the Plugins screen: removes every
// option, the connector key and every stored answer, and leaves nothing
// behind (WordPress Plugin Handbook, uninstall methods).

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

foreach ( array( 'trooth_semanto_trooth_id', 'trooth_semanto_mode', 'trooth_semanto_api_base', 'trooth_semanto_connector_key', 'trooth_semanto_last_sync' ) as $option ) {
	delete_option( $option );
}
delete_transient( 'trooth_semanto_sync_pending' );
wp_clear_scheduled_hook( 'trooth_semanto_sync_products' );

global $wpdb;
foreach ( array( '_transient_trooth_semanto_', '_transient_timeout_trooth_semanto_' ) as $prefix ) {
	// phpcs:ignore WordPress.DB.DirectDatabaseQuery
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( $prefix ) . '%' ) );
}
