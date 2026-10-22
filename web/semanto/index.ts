// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto dashboard panels for trooth-web. Each takes plain data and
// callbacks; none fetches. Drop the folder into src/components/semanto.

export { DeliverySettingsPanel, HOST_TEXT, type DeliverySettingsData, type DeliverySettingsPanelProps, type HostDetection, type HostKind, type MarkdownSource, type WhenPageChanged } from "./delivery-settings-panel";
export { ConsistencyMonitorPanel, KIND_TEXT, type ConsistencyMonitorPanelProps, type Mismatch, type MismatchKind, type Severity } from "./consistency-monitor-panel";
export { GapReportPanel, CLASSIFICATION_TEXT, type GapReportPanelProps, type ProviderSummary, type Correction, type Classification, type GapCounts } from "./gap-report-panel";
export { ReadReceiptsPanel, type ReadReceiptsPanelProps, type ReadReceiptDay, type ProvenAgent } from "./read-receipts-panel";
export { KeyBindingPanel, BINDING_TEXT, TWO_OFFICER_TEXT, type KeyBindingPanelProps, type KeyBindingData, type BindingLevel } from "./key-binding-panel";
export { BasicUpgradeCard, type BasicUpgradeCardProps } from "./basic-upgrade-card";
export { fmtDate, fmtDateTime, fmtCount, SURFACE_TEXT, SEVERITY_TEXT } from "./format";
