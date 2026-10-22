// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto setup wizard for trooth-web: the container, the six screens of
// docs/audit/workflow-research.md section 5, and the client for
// docs/spec/setup-api.md. Drop the folder into src/components/semanto/setup.

export { SetupWizard, SCREENS, screenFor, type SetupWizardProps } from "./SetupWizard";
export { ScreenSignIn, type ScreenSignInProps } from "./ScreenSignIn";
export { ScreenCompany, type ScreenCompanyProps } from "./ScreenCompany";
export { ScreenProveDomain, type ScreenProveDomainProps } from "./ScreenProveDomain";
export { ScreenWhatWasRead, BASIC_NOTICE, groupLeftOut, type ScreenWhatWasReadProps } from "./ScreenWhatWasRead";
export { ScreenReviewAndSign, signedLine, type ScreenReviewAndSignProps } from "./ScreenReviewAndSign";
export { ScreenInstall, CHECK_LABELS, type ScreenInstallProps } from "./ScreenInstall";
export { createSetupClient, publicSemantoUrl, errorWords, SetupApiError, REQUEST_TIMEOUT_MS, type SetupClient, type SetupClientOptions } from "./api";
export { cleanDomain, type DomainCheck } from "./domain";
export { POLL_SCHEDULE_MS, pollDelay, stateFingerprint } from "./poll";
export { guideFor, headCode, GUIDE_IDS, HOST_CHOICES, HOST_NAMES, type Guide } from "./guides";
export type * from "./types";
