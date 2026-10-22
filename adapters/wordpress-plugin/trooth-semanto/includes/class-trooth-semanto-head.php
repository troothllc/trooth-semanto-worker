<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// What goes in <head>: a <link rel="alternate" type="text/markdown"> to the
// page's signed markdown on this domain (RFC 8288 link relations, as Cloudflare
// and the llms.txt convention use them), a <link rel="https://trooth.co/rel/semanto">
// to the hosted copy, and the JSON-LD facts block the API built from the
// signed record (schema.org JSON-LD, as Google's structured data guidance
// expects it in the page).

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_Head {

	private Trooth_Semanto_Client $client;
	private string $mode;

	public function __construct( Trooth_Semanto_Client $client, string $mode ) {
		$this->client = $client;
		$this->mode   = $mode;
	}

	public function register(): void {
		add_action( 'wp_head', array( $this, 'print_links' ), 2 );
		add_action( 'wp_head', array( $this, 'print_jsonld' ), 3 );
	}

	public function print_links(): void {
		$path     = Trooth_Semanto_Serve::request_path();
		$manifest = $this->client->manifest();
		$root     = $this->client->api_root();
		echo '<link rel="https://trooth.co/rel/semanto" href="' . esc_url( $root ) . '">' . "\n";
		if ( 'proof_only' === $this->mode ) {
			return;
		}
		$page = Trooth_Semanto_Negotiate::find_page( $manifest, $path );
		if ( ! $page ) {
			return;
		}
		$base = Trooth_Semanto_Negotiate::normalize_path( $path );
		$md   = '/' === $base ? '/index.md' : $base . '.md';
		echo '<link rel="alternate" type="text/markdown" href="' . esc_url( home_url( $md ) ) . '">' . "\n";
	}

	public function print_jsonld(): void {
		if ( 'proof_only' === $this->mode ) {
			return;
		}
		/**
		 * Where the facts block is printed. Default: the front page and any page
		 * listed in the Semanto. Return true to print it on every page.
		 */
		$everywhere = apply_filters( 'trooth_semanto_jsonld_everywhere', false );
		if ( ! $everywhere && ! is_front_page() && ! Trooth_Semanto_Negotiate::find_page( $this->client->manifest(), Trooth_Semanto_Serve::request_path() ) ) {
			return;
		}
		$json = $this->client->facts_jsonld();
		if ( null === $json ) {
			return;
		}
		// The block is printed exactly as the API built it; only "</script" is made safe.
		$safe = str_ireplace( '</script', '<\/script', $json );
		echo '<script type="application/ld+json" data-trooth-semanto="facts">' . $safe . '</script>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput
	}
}
