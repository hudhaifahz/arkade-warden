export const durationPresets = [
  { id: "3h", label: "3 hours", durationSeconds: 3 * 60 * 60, rolloverRequired: false },
  { id: "24h", label: "24 hours", durationSeconds: 24 * 60 * 60, rolloverRequired: false },
  { id: "3d", label: "3 days", durationSeconds: 3 * 24 * 60 * 60, rolloverRequired: false },
  { id: "7d", label: "7 days", durationSeconds: 7 * 24 * 60 * 60, rolloverRequired: true },
  { id: "10d", label: "10 days", durationSeconds: 10 * 24 * 60 * 60, rolloverRequired: true },
  { id: "30d", label: "30 days", durationSeconds: 30 * 24 * 60 * 60, rolloverRequired: true },
  { id: "3mo", label: "3 months", durationSeconds: 90 * 24 * 60 * 60, rolloverRequired: true },
  { id: "6mo", label: "6 months", durationSeconds: 180 * 24 * 60 * 60, rolloverRequired: true },
  { id: "12mo", label: "12 months", durationSeconds: 365 * 24 * 60 * 60, rolloverRequired: true },
] as const;

export type DurationPresetId = (typeof durationPresets)[number]["id"];
export type DurationPreset = (typeof durationPresets)[number];

export const durationPresetById = (id: string): DurationPreset => {
  const preset = durationPresets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown escrow duration preset ${id}`);
  return preset;
};

export type ActivationGates = {
  schemaVersion: 1;
  fundedManualRollover: {
    verified: boolean;
    contractId?: string;
    commitmentTxid?: string;
    verifiedAt?: string;
  };
  expiryRecoveryDrill: {
    verified: boolean;
    contractId?: string;
    recoveryTxid?: string;
    verifiedAt?: string;
  };
  automaticLongTerm: {
    enabled: boolean;
    enabledAt?: string;
  };
};

export const defaultActivationGates = (): ActivationGates => ({
  schemaVersion: 1,
  fundedManualRollover: { verified: false },
  expiryRecoveryDrill: { verified: false },
  automaticLongTerm: { enabled: false },
});

export const longTermAutomationReady = (gates: ActivationGates) =>
  gates.fundedManualRollover.verified &&
  gates.expiryRecoveryDrill.verified &&
  gates.automaticLongTerm.enabled;
