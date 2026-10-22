<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Signed POSTs from this site to the Trooth API: RFC 9421 HTTP Message
// Signatures with an RFC 9530 Content-Digest, Ed25519 through the sodium
// extension that ships with PHP 7.2 and later. The signature base is the same
// one adapters/shared/sign-request.mjs builds and src/core/httpsig.ts
// verifies: components "@method" "@target-uri" "content-digest" "content-type",
// parameters created, expires, keyid (RFC 7638 thumbprint), alg="ed25519",
// tag="trooth-connector". The key pair is made once on this site; the public
// half is shown on the settings page for the owner to paste into the Trooth
// dashboard, the private half stays in the options table and is never shown.

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Trooth_Semanto_Signer {

	const OPTION = 'trooth_semanto_connector_key';
	const TAG    = 'trooth-connector';

	public static function available(): bool {
		return function_exists( 'sodium_crypto_sign_keypair' );
	}

	private static function b64url( string $bin ): string {
		return rtrim( strtr( base64_encode( $bin ), '+/', '-_' ), '=' );
	}

	private static function b64url_decode( string $s ): string {
		return (string) base64_decode( strtr( $s, '-_', '+/' ) . str_repeat( '=', ( 4 - strlen( $s ) % 4 ) % 4 ) );
	}

	/** RFC 7638: SHA-256 over the canonical JSON of the required members, in lexicographic order. */
	public static function thumbprint( string $x ): string {
		return self::b64url( hash( 'sha256', '{"crv":"Ed25519","kty":"OKP","x":"' . $x . '"}', true ) );
	}

	/** @return array{kid:string,x:string,d:string}|null */
	public static function key(): ?array {
		$k = get_option( self::OPTION );
		if ( is_array( $k ) && isset( $k['x'], $k['d'], $k['kid'] ) ) {
			return $k;
		}
		if ( ! self::available() ) {
			return null;
		}
		$pair = sodium_crypto_sign_keypair();
		$pub  = sodium_crypto_sign_publickey( $pair );
		$sec  = sodium_crypto_sign_secretkey( $pair );
		// The JWK "d" is the 32-byte seed; sodium's secret key is seed plus public key.
		$seed = substr( $sec, 0, SODIUM_CRYPTO_SIGN_SEEDBYTES );
		$x    = self::b64url( $pub );
		$k    = array( 'kid' => self::thumbprint( $x ), 'x' => $x, 'd' => self::b64url( $seed ), 'created' => gmdate( 'c' ) );
		add_option( self::OPTION, $k, '', false );
		return $k;
	}

	/** The public JWK to paste into the Trooth dashboard. @return array<string,string>|null */
	public static function public_jwk(): ?array {
		$k = self::key();
		if ( ! $k ) {
			return null;
		}
		return array( 'kty' => 'OKP', 'crv' => 'Ed25519', 'x' => $k['x'], 'kid' => $k['kid'], 'alg' => 'EdDSA', 'use' => 'sig' );
	}

	public static function rotate(): void {
		delete_option( self::OPTION );
		self::key();
	}

	private static function sf_string( string $s ): string {
		return '"' . str_replace( array( '\\', '"' ), array( '\\\\', '\\"' ), $s ) . '"';
	}

	/**
	 * The headers for a signed POST: Content-Type, Content-Digest, Signature-Input, Signature.
	 *
	 * @return array<string,string>|WP_Error
	 */
	public static function sign_post( string $url, string $body, string $content_type = 'application/json', ?int $created = null, int $ttl = 300 ) {
		$k = self::key();
		if ( ! $k ) {
			return new WP_Error( 'trooth_semanto_no_sodium', 'This server has no sodium extension, so the plugin cannot sign the product data.' );
		}
		$created = $created ?? time();
		$digest  = 'sha-256=:' . base64_encode( hash( 'sha256', $body, true ) ) . ':';
		$params  = ';created=' . $created . ';expires=' . ( $created + $ttl ) . ';keyid=' . self::sf_string( $k['kid'] ) . ';alg="ed25519";tag=' . self::sf_string( self::TAG );
		$inner   = '("@method" "@target-uri" "content-digest" "content-type")' . $params;
		$base    = implode(
			"\n",
			array(
				'"@method": POST',
				'"@target-uri": ' . $url,
				'"content-digest": ' . $digest,
				'"content-type": ' . $content_type,
				'"@signature-params": ' . $inner,
			)
		);
		$seed    = self::b64url_decode( $k['d'] );
		$pair    = sodium_crypto_sign_seed_keypair( $seed );
		$sig     = sodium_crypto_sign_detached( $base, sodium_crypto_sign_secretkey( $pair ) );
		return array(
			'Content-Type'    => $content_type,
			'Content-Digest'  => $digest,
			'Signature-Input' => 'sig1=' . $inner,
			'Signature'       => 'sig1=:' . base64_encode( $sig ) . ':',
		);
	}

	/** POST a JSON document, signed. @return array|WP_Error */
	public static function post_json( string $url, array $document ) {
		$body    = wp_json_encode( $document );
		$headers = self::sign_post( $url, $body );
		if ( is_wp_error( $headers ) ) {
			return $headers;
		}
		return wp_remote_post(
			$url,
			array(
				'timeout'    => 20,
				'headers'    => $headers,
				'body'       => $body,
				'user-agent' => 'trooth-semanto-wordpress/' . TROOTH_SEMANTO_VERSION,
			)
		);
	}
}
