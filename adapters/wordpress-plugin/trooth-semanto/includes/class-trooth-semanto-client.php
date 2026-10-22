<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Talks to the public Trooth API with wp_remote_get and keeps each answer in a
// transient keyed by its URL, with the ETag the API sent. After the cache time
// the next request revalidates with If-None-Match; a 304 keeps the stored
// bytes. The manifest (the company's Semanto file) is one such entry. Follows
// the WordPress HTTP API (developer.wordpress.org/plugins/http-api/) and the
// Transients API (developer.wordpress.org/apis/transients/).

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_Client {

	const TRANSIENT_PREFIX = 'trooth_semanto_';
	const TTL              = 300;
	/** Pages above this size are streamed through without being stored. */
	const MAX_CACHED_BYTES = 1048576;

	private string $api_root;

	public function __construct( string $api_root ) {
		$this->api_root = $api_root;
	}

	public function api_root(): string {
		return $this->api_root;
	}

	/**
	 * Fetch a URL on the API, through the cache.
	 *
	 * @param array<string,string> $request_headers Headers from the reader to pass along (Accept, If-None-Match).
	 * @return array{status:int, headers:array<string,string>, body:string, from_cache:bool}|WP_Error
	 */
	public function get( string $url, array $request_headers = array() ) {
		$key    = self::TRANSIENT_PREFIX . md5( $url . '|' . ( $request_headers['Accept'] ?? '' ) );
		$cached = get_transient( $key );
		$fresh  = is_array( $cached ) && isset( $cached['fetched'] ) && ( time() - (int) $cached['fetched'] ) < self::TTL;
		// A reader that signed its request (Web Bot Auth) always reaches the API, so its read can be proven and recorded.
		$signed_reader = ! empty( $request_headers['Signature-Input'] ) && ! empty( $request_headers['Signature'] ) && ! empty( $request_headers['Signature-Agent'] );
		if ( $fresh && ! $signed_reader ) {
			return $this->answer_from( $cached, $request_headers );
		}
		$headers = array();
		foreach ( array( 'Accept', 'Accept-Language', 'Signature-Input', 'Signature', 'Signature-Agent' ) as $h ) {
			if ( ! empty( $request_headers[ $h ] ) ) {
				$headers[ $h ] = $request_headers[ $h ];
			}
		}
		if ( $signed_reader ) {
			// Vouch for the host the reader addressed and its address, signed with the connector key.
			$headers['Trooth-Forwarded-Authority'] = strtolower( (string) ( $request_headers['Host'] ?? wp_parse_url( home_url(), PHP_URL_HOST ) ) );
			$headers['Trooth-Forwarded-For']       = (string) ( $request_headers['Client-Address'] ?? '' );
			$fwd = Trooth_Semanto_Signer::available() ? Trooth_Semanto_Signer::sign_forwarding( $url, $headers ) : null;
			if ( $fwd ) {
				$headers = array_merge( $headers, $fwd );
			} else {
				unset( $headers['Trooth-Forwarded-Authority'], $headers['Trooth-Forwarded-For'] );
			}
		}
		if ( is_array( $cached ) && ! empty( $cached['etag'] ) ) {
			$headers['If-None-Match'] = $cached['etag'];
		}
		$res = wp_remote_get(
			$url,
			array(
				'timeout'     => 10,
				'redirection' => 3,
				'headers'     => $headers,
				// The default WordPress user agent names the site; the API does not need it.
				'user-agent'  => 'trooth-semanto-wordpress/' . TROOTH_SEMANTO_VERSION,
			)
		);
		if ( is_wp_error( $res ) ) {
			if ( is_array( $cached ) ) {
				return $this->answer_from( $cached, $request_headers );
			}
			return $res;
		}
		$status = (int) wp_remote_retrieve_response_code( $res );
		if ( 304 === $status && is_array( $cached ) ) {
			$cached['fetched'] = time();
			set_transient( $key, $cached, DAY_IN_SECONDS );
			return $this->answer_from( $cached, $request_headers );
		}
		$out_headers = array();
		foreach ( Trooth_Semanto_Negotiate::TROOTH_HEADERS as $name ) {
			$v = wp_remote_retrieve_header( $res, $name );
			if ( is_array( $v ) ) {
				$v = implode( ', ', $v );
			}
			if ( '' !== $v && null !== $v ) {
				$out_headers[ $name ] = (string) $v;
			}
		}
		$body  = (string) wp_remote_retrieve_body( $res );
		$entry = array(
			'status'  => $status,
			'headers' => $out_headers,
			'body'    => $body,
			'etag'    => $out_headers['ETag'] ?? null,
			'fetched' => time(),
		);
		if ( $status >= 200 && $status < 400 && strlen( $body ) <= self::MAX_CACHED_BYTES ) {
			set_transient( $key, $entry, DAY_IN_SECONDS );
		}
		return $this->answer_from( $entry, $request_headers, false );
	}

	/** Honour the reader's own If-None-Match against the stored ETag. */
	private function answer_from( array $entry, array $request_headers, bool $from_cache = true ): array {
		$inm = $request_headers['If-None-Match'] ?? '';
		if ( '' !== $inm && ! empty( $entry['etag'] ) && $inm === $entry['etag'] ) {
			return array(
				'status'     => 304,
				'headers'    => $entry['headers'],
				'body'       => '',
				'from_cache' => $from_cache,
			);
		}
		return array(
			'status'     => (int) $entry['status'],
			'headers'    => $entry['headers'],
			'body'       => (string) $entry['body'],
			'from_cache' => $from_cache,
		);
	}

	/** The current manifest as an array, or null when the API cannot be reached and nothing is stored. */
	public function manifest(): ?array {
		$res = $this->get( $this->api_root, array( 'Accept' => 'application/json' ) );
		if ( is_wp_error( $res ) || $res['status'] < 200 || $res['status'] >= 300 ) {
			return null;
		}
		$json = json_decode( $res['body'], true );
		return is_array( $json ) ? $json : null;
	}

	/** The facts file as a string of JSON-LD, or null. */
	public function facts_jsonld(): ?string {
		$res = $this->get( $this->api_root . '/facts.jsonld', array( 'Accept' => 'application/ld+json' ) );
		if ( is_wp_error( $res ) || 200 !== $res['status'] ) {
			return null;
		}
		return $res['body'];
	}

	/** Drop every stored answer, for the settings page button and for uninstall. */
	public static function flush(): void {
		global $wpdb;
		$like = $wpdb->esc_like( '_transient_' . self::TRANSIENT_PREFIX ) . '%';
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $like ) );
		$like = $wpdb->esc_like( '_transient_timeout_' . self::TRANSIENT_PREFIX ) . '%';
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $like ) );
		wp_cache_flush();
	}
}
