// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Minimal module declarations so the dashboard components typecheck inside
// this worker repository, which ships no React. trooth-web has the real
// @types/react and lucide-react; this file is not copied there.

declare module "react" {
  export type ReactNode = string | number | boolean | null | undefined | ReactElement | ReactNode[];
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | number | null;
  }
  export type Key = string | number;
  export interface FC<P = {}> {
    (props: P): ReactElement | null;
  }
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useId(): string;
  export namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
    interface Element extends ReactElement {}
    interface ElementChildrenAttribute {
      children: {};
    }
  }
}

declare module "react/jsx-runtime" {
  import type { ReactElement } from "react";
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
  export namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
    interface Element extends ReactElement {}
    interface ElementChildrenAttribute {
      children: {};
    }
  }
}

declare module "lucide-react" {
  import type { FC } from "react";
  type IconProps = { className?: string; "aria-hidden"?: boolean | "true" | "false"; size?: number };
  export const AlertTriangle: FC<IconProps>;
  export const ArrowRight: FC<IconProps>;
  export const Check: FC<IconProps>;
  export const Download: FC<IconProps>;
  export const ExternalLink: FC<IconProps>;
  export const Globe: FC<IconProps>;
  export const Info: FC<IconProps>;
  export const KeyRound: FC<IconProps>;
  export const RefreshCw: FC<IconProps>;
  export const Server: FC<IconProps>;
  export const ShieldCheck: FC<IconProps>;
  export const X: FC<IconProps>;
}
