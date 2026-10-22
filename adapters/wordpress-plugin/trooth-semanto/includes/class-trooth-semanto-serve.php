<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The front door: on template_redirect (before WordPress's canonical redirect
// runs at priority 10) the plugin decides on Accept and path suffix, and either
// prints the bytes it fetched from the Trooth API with the API's headers, or
// steps aside and adds the Trooth-Semanto-Version and Link headers to the
// site's own HTML through send_headers. Nothing here reads User-Agent.

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_Serve {

	private Trooth_Semanto_Client $client;
	private string $mode;

	public function __construct( Trooth_Semanto_Client $client, string $mode ) {
		$this->client = $client;
		$this->mode   = $mode;
	}

	public function register(): void {
		add_action( 'template_redirect', array( $this, 'maybe_serve' ), 0 );
		add_action( 'send_headers', array( $this, 'add_proof_headers' ) );
		// WordPress would 404 and canonical-redirect our suffix paths; keep them as they are.
		add_filter( 'redirect_canonical', array( $this, 'keep_suffix_paths' ), 10, 2 );
	}

	public static function request_path(): string {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$path = (string) ( wp_parse_url( $uri, PHP_URL_PATH ) ?? '/' );
		// A site installed in a subfolder: compare paths relative to the home url.
		$home = (string) ( wp_parse_url( home_url( '/' ), PHP_URL_PATH ) ?? '/' );
		if ( '/' !== $home && 0 === strpos( $path, rtrim( $home, '/' ) ) ) {
			$path = substr( $path, strlen( rtrim( $home, '/' ) ) ) ?: '/';
		}
		return $path;
	}

	private static function accept(): ?string {
		return isset( $_SERVER['HTTP_ACCEPT'] ) ? (string) wp_unslash( $_SERVER['HTTP_ACCEPT'] ) : null; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	}

	private static function method(): string {
		return isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	}

	public function decision(): array {
		return Trooth_Semanto_Negotiate::decide( self::request_path(), self::accept(), $this->client->manifest(), $this->client->api_root(), $this->mode, self::method() );
	}

	public function maybe_serve(): void {
		if ( is_admin() || wp_doing_ajax() || wp_doing_cron() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
			return;
		}
		$decision = $this->decision();
		if ( ! $decision['serve'] ) {
			return;
		}
		$request_headers = array();
		foreach ( array( 'Accept' => 'HTTP_ACCEPT', 'Accept-Language' => 'HTTP_ACCEPT_LANGUAGE', 'If-None-Match' => 'HTTP_IF_NONE_MATCH', 'Signature-Input' => 'HTTP_SIGNATURE_INPUT', 'Signature' => 'HTTP_SIGNATURE', 'Signature-Agent' => 'HTTP_SIGNATURE_AGENT' ) as $name => $key ) {
			if ( ! empty( $_SERVER[ $key ] ) ) {
				$request_headers[ $name ] = (string) wp_unslash( $_SERVER[ $key ] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			}
		}
		$res = $this->client->get( $decision['url'], $request_headers );
		if ( is_wp_error( $res ) ) {
			$this->problem( 503, 'The signed copy could not be fetched right now. Try again in a minute.' );
		}
		$this->emit( $res['status'], $res['headers'], 'HEAD' === self::method() ? '' : $res['body'] );
	}

	/** Print a response and stop. Headers come from the API, byte for byte. */
	private function emit( int $status, array $headers, string $body ): void {
		// Drop headers WordPress or PHP already queued; the API's answer is the whole answer.
		if ( ! headers_sent() ) {
			header_remove( 'X-Pingback' );
			header_remove( 'Link' );
			header_remove( 'Content-Type' );
		}
		status_header( $status );
		foreach ( $headers as $name => $value ) {
			header( $name . ': ' . $value, true );
		}
		if ( ! isset( $headers['Vary'] ) ) {
			header( 'Vary: Accept', true );
		}
		if ( ! isset( $headers['Cache-Control'] ) ) {
			header( 'Cache-Control: public, max-age=60, must-revalidate', true );
		}
		// phpcs:ignore WordPress.Security.EscapeOutput -- bytes from the signed copy, printed as received.
		echo $body;
		exit;
	}

	/** An RFC 9457 problem in the form the reader asked for. */
	private function problem( int $status, string $detail ): void {
		$rep = Trooth_Semanto_Negotiate::negotiate( self::accept() );
		status_header( $status );
		header( 'Vary: Accept', true );
		if ( 'markdown' === $rep ) {
			header( 'Content-Type: text/markdown; charset=utf-8', true );
			echo "# Not available\n\n" . esc_html( $detail ) . "\n";
		} else {
			header( 'Content-Type: application/problem+json', true );
			echo wp_json_encode(
				array(
					'type'        => 'https://trooth.co/problems/upstream-unavailable',
					'title'       => 'Not available',
					'status'      => $status,
					'detail'      => $detail,
					'code'        => 'upstream_unavailable',
					'retryable'   => true,
					'next_action' => 'Retry after a minute, or read the copy on the Trooth Network.',
					'terminal'    => false,
				)
			);
		}
		exit;
	}

	public function add_proof_headers(): void {
		if ( is_admin() || headers_sent() ) {
			return;
		}
		$decision = $this->decision();
		if ( $decision['serve'] ) {
			return;
		}
		foreach ( Trooth_Semanto_Negotiate::proof_headers( $this->client->manifest(), self::request_path(), $this->client->api_root() ) as $name => $value ) {
			header( $name . ': ' . $value, 'Link' !== $name );
		}
	}

	public function keep_suffix_paths( $redirect_url, $requested_url ) {
		$path = (string) ( wp_parse_url( (string) $requested_url, PHP_URL_PATH ) ?? '/' );
		if ( preg_match( '#(\.md|\.jsonld)$#', $path ) || isset( Trooth_Semanto_Negotiate::WELL_KNOWN[ $path ] ) ) {
			return false;
		}
		return $redirect_url;
	}
}
