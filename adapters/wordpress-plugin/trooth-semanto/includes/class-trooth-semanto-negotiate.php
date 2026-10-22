<?php
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The decision, in PHP: the same algorithm as adapters/shared/semanto-adapter.mjs
// (RFC 9110 section 12.5.1 negotiation with the outcomes Cloudflare's Markdown
// for Agents documents, 26 February 2026) and the same path-suffix rule. Pure
// functions, no WordPress calls, so they can be run from the command line.
// Nothing here reads the User-Agent header.

if ( ! defined( 'ABSPATH' ) && PHP_SAPI !== 'cli' ) {
	exit;
}

final class Trooth_Semanto_Negotiate {

	const MODES = array( 'semanto_only', 'semanto_then_cloudflare_for_unsigned', 'proof_only' );

	/** The response headers the plugin forwards from the API, and nothing else. */
	const TROOTH_HEADERS = array(
		'Content-Type',
		'ETag',
		'Vary',
		'Content-Digest',
		'Signature-Input',
		'Signature',
		'Trooth-Contract',
		'Trooth-Semanto-Version',
		'Trooth-Page-Hash',
		'Trooth-Signed-Page-Hash',
		'Trooth-Signed-By',
		'Trooth-Semanto-State',
		'Link',
		'Content-Signal',
		'x-markdown-tokens',
		'x-original-tokens',
	);

	/** Path on this site => [ api path relative to the company root, group ]. */
	const WELL_KNOWN = array(
		'/.well-known/trooth.semanto'   => array( '', 'well_known' ),
		'/.well-known/trooth-keys.json' => array( '/keys.json', 'well_known' ),
		'/llms.txt'                     => array( '/llms.txt', 'llms' ),
		'/llms-full.txt'                => array( '/llms-full.txt', 'llms' ),
		'/sitemap.md'                   => array( '/sitemap.md', 'llms' ),
	);

	const MEDIA = array(
		'html'     => 'text/html',
		'markdown' => 'text/markdown',
		'jsonld'   => 'application/ld+json',
	);

	/** Markdown is offered first, so "text/*" gets markdown; "*\/*" still gets html. */
	const OFFERED = array( 'markdown', 'html', 'jsonld' );

	public static function normalize_mode( $mode ): string {
		return in_array( $mode, self::MODES, true ) ? $mode : 'semanto_only';
	}

	/** @return array<int, array{type:string,subtype:string,q:float,order:int,specificity:int}> */
	public static function parse_accept( ?string $accept ): array {
		if ( null === $accept || '' === trim( $accept ) ) {
			return array();
		}
		$out = array();
		foreach ( explode( ',', $accept ) as $order => $part ) {
			$pieces = explode( ';', trim( $part ) );
			$mt     = array_shift( $pieces );
			if ( '' === $mt || false === strpos( $mt, '/' ) ) {
				continue;
			}
			list( $type, $subtype ) = array_map( 'trim', explode( '/', $mt, 2 ) );
			$type    = strtolower( $type );
			$subtype = strtolower( $subtype );
			$q       = 1.0;
			foreach ( $pieces as $p ) {
				$kv = array_map( 'trim', explode( '=', $p, 2 ) );
				if ( count( $kv ) === 2 && strtolower( $kv[0] ) === 'q' ) {
					$q = is_numeric( $kv[1] ) ? min( 1.0, max( 0.0, (float) $kv[1] ) ) : 0.0;
				}
			}
			$specificity = '*' === $type ? 0 : ( '*' === $subtype ? 1 : 2 );
			$out[]       = array(
				'type'        => $type,
				'subtype'     => $subtype,
				'q'           => $q,
				'order'       => $order,
				'specificity' => $specificity,
			);
		}
		return $out;
	}

	private static function matches( array $r, string $media ): bool {
		list( $t, $s ) = explode( '/', $media, 2 );
		return ( '*' === $r['type'] || $r['type'] === $t ) && ( '*' === $r['subtype'] || $r['subtype'] === $s );
	}

	public static function negotiate( ?string $accept, array $offered = self::OFFERED, string $fallback = 'html' ): string {
		$ranges = self::parse_accept( $accept );
		if ( empty( $ranges ) ) {
			return $fallback;
		}
		$best = null;
		foreach ( $offered as $idx => $rep ) {
			$media  = self::MEDIA[ $rep ];
			$chosen = null;
			foreach ( $ranges as $r ) {
				if ( ! self::matches( $r, $media ) ) {
					continue;
				}
				if ( null === $chosen || $r['specificity'] > $chosen['specificity'] ) {
					$chosen = $r;
				}
			}
			if ( null === $chosen || 0.0 === $chosen['q'] ) {
				continue;
			}
			if ( 0 === $chosen['specificity'] && $rep !== $fallback ) {
				continue;
			}
			$cand = array(
				'rep'  => $rep,
				'q'    => $chosen['q'],
				'spec' => $chosen['specificity'],
				'idx'  => $idx,
			);
			if ( null === $best || $cand['q'] > $best['q'] || ( $cand['q'] === $best['q'] && ( $cand['spec'] > $best['spec'] || ( $cand['spec'] === $best['spec'] && $cand['idx'] < $best['idx'] ) ) ) ) {
				$best = $cand;
			}
		}
		return $best ? $best['rep'] : $fallback;
	}

	/** @return array{rep:?string,base:string} */
	public static function representation_from_path( string $path ): array {
		if ( self::ends_with( $path, '/index.md' ) ) {
			return array( 'rep' => 'markdown', 'base' => substr( $path, 0, -strlen( 'index.md' ) ) );
		}
		if ( self::ends_with( $path, '.md' ) ) {
			return array( 'rep' => 'markdown', 'base' => substr( $path, 0, -3 ) ?: '/' );
		}
		if ( self::ends_with( $path, '/facts.jsonld' ) ) {
			return array( 'rep' => 'jsonld', 'base' => substr( $path, 0, -strlen( 'facts.jsonld' ) ) );
		}
		if ( self::ends_with( $path, '.jsonld' ) ) {
			return array( 'rep' => 'jsonld', 'base' => substr( $path, 0, -7 ) ?: '/' );
		}
		return array( 'rep' => null, 'base' => $path );
	}

	public static function normalize_path( string $path ): string {
		$p = '' === $path ? '/' : $path;
		if ( '/' !== $p[0] ) {
			$p = '/' . $p;
		}
		if ( strlen( $p ) > 1 && self::ends_with( $p, '/' ) ) {
			$p = substr( $p, 0, -1 );
		}
		return $p;
	}

	private static function ends_with( string $s, string $suffix ): bool {
		return '' === $suffix || substr( $s, -strlen( $suffix ) ) === $suffix;
	}

	/** @return array<int, array<string, mixed>> */
	public static function pages_of( $manifest ): array {
		if ( ! is_array( $manifest ) ) {
			return array();
		}
		if ( isset( $manifest['header']['pages_manifest'] ) && is_array( $manifest['header']['pages_manifest'] ) ) {
			return $manifest['header']['pages_manifest'];
		}
		if ( isset( $manifest['pages_manifest'] ) && is_array( $manifest['pages_manifest'] ) ) {
			return $manifest['pages_manifest'];
		}
		return array_is_list( $manifest ) ? $manifest : array();
	}

	public static function manifest_version( $manifest ): ?string {
		if ( isset( $manifest['header']['version'] ) ) {
			return (string) $manifest['header']['version'];
		}
		if ( isset( $manifest['version'] ) ) {
			return (string) $manifest['version'];
		}
		return null;
	}

	/** @return ?array<string, mixed> */
	public static function find_page( $manifest, string $path ): ?array {
		$want = self::normalize_path( $path );
		foreach ( self::pages_of( $manifest ) as $page ) {
			if ( empty( $page['url'] ) ) {
				continue;
			}
			$pp = (string) ( wp_parse_url_compat( $page['url'] ) ?? '/' );
			if ( self::normalize_path( $pp ) === $want ) {
				return $page;
			}
		}
		return null;
	}

	/**
	 * The decision.
	 *
	 * @return array{serve:bool, url?:string, kind?:string, reason?:string, page?:array}
	 */
	public static function decide( string $path, ?string $accept, $manifest, string $api_root, string $mode, string $method = 'GET' ): array {
		$mode   = self::normalize_mode( $mode );
		$method = strtoupper( $method );
		if ( 'GET' !== $method && 'HEAD' !== $method ) {
			return array( 'serve' => false, 'reason' => 'method' );
		}
		$path = self::strip_query( $path );
		if ( isset( self::WELL_KNOWN[ $path ] ) ) {
			list( $api, $group ) = self::WELL_KNOWN[ $path ];
			if ( 'proof_only' === $mode && 'well_known' !== $group ) {
				return array( 'serve' => false, 'reason' => 'mode' );
			}
			return array( 'serve' => true, 'url' => $api_root . $api, 'kind' => $group );
		}
		if ( 'proof_only' === $mode ) {
			return array( 'serve' => false, 'reason' => 'mode' );
		}
		$by_suffix = self::representation_from_path( $path );
		$rep       = $by_suffix['rep'] ?? self::negotiate( $accept );
		if ( 'html' === $rep ) {
			return array( 'serve' => false, 'reason' => 'html' );
		}
		$page = self::find_page( $manifest, $by_suffix['base'] );
		if ( 'jsonld' === $rep ) {
			// The site root's /facts.jsonld is the company's facts; any other JSON-LD request is the page's JSON-LD, as the API answers it.
			if ( '/facts.jsonld' === $path ) {
				return array( 'serve' => true, 'url' => $api_root . '/facts.jsonld', 'kind' => 'facts' );
			}
			if ( ! $page && 'semanto_then_cloudflare_for_unsigned' === $mode ) {
				return array( 'serve' => false, 'reason' => 'not_listed' );
			}
			return array( 'serve' => true, 'url' => $api_root . '/by-path' . $path, 'kind' => 'page_jsonld' );
		}
		if ( $page && ! empty( $page['id'] ) ) {
			// The ".md" suffix fixes the representation at the API whatever Accept the reader sent.
			return array( 'serve' => true, 'url' => $api_root . '/pages/' . rawurlencode( (string) $page['id'] ) . '.md', 'kind' => 'page', 'page' => $page );
		}
		if ( 'semanto_then_cloudflare_for_unsigned' === $mode ) {
			return array( 'serve' => false, 'reason' => 'not_listed' );
		}
		return array( 'serve' => true, 'url' => $api_root . '/by-path' . $path, 'kind' => 'page_lookup' );
	}

	private static function strip_query( string $path ): string {
		$q = strpos( $path, '?' );
		if ( false !== $q ) {
			$path = substr( $path, 0, $q );
		}
		$h = strpos( $path, '#' );
		if ( false !== $h ) {
			$path = substr( $path, 0, $h );
		}
		return '' === $path ? '/' : $path;
	}

	/** The headers added to the site's own HTML. @return array<string,string> */
	public static function proof_headers( $manifest, string $path, string $api_root ): array {
		$out     = array();
		$version = self::manifest_version( $manifest );
		if ( null !== $version ) {
			$out['Trooth-Semanto-Version'] = $version;
		}
		$links = array( '<' . $api_root . '>; rel="https://trooth.co/rel/semanto"' );
		$page  = self::find_page( $manifest, self::strip_query( $path ) );
		if ( $page ) {
			$base    = self::normalize_path( self::strip_query( $path ) );
			$md      = '/' === $base ? '/index.md' : $base . '.md';
			$links[] = '<' . $md . '>; rel="alternate"; type="text/markdown"';
		}
		$out['Link'] = implode( ', ', $links );
		return $out;
	}
}

if ( ! function_exists( 'wp_parse_url_compat' ) ) {
	/** The path of an absolute url, with or without WordPress loaded. */
	function wp_parse_url_compat( string $url ): ?string {
		$p = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url, PHP_URL_PATH ) : parse_url( $url, PHP_URL_PATH );
		return is_string( $p ) ? $p : '/';
	}
}
