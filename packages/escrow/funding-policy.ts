export type FundingState = "unbounded-legacy" | "unfunded" | "underfunded" | "funded" | "overfunded";

export const assessFunding = (expectedAmountSats: number | undefined, fundedAmountSats: number) => {
  if (!Number.isSafeInteger(fundedAmountSats) || fundedAmountSats < 0) {
    throw new Error("Funded escrow amount is invalid");
  }
  if (expectedAmountSats === undefined) {
    return { state: "unbounded-legacy" as const, fundedAmountSats };
  }
  if (!Number.isSafeInteger(expectedAmountSats) || expectedAmountSats <= 0) {
    throw new Error("Expected escrow amount is invalid");
  }
  if (fundedAmountSats === 0) {
    return {
      state: "unfunded" as const,
      expectedAmountSats,
      fundedAmountSats,
      remainingAmountSats: expectedAmountSats,
      overfundedAmountSats: 0,
    };
  }
  if (fundedAmountSats < expectedAmountSats) {
    return {
      state: "underfunded" as const,
      expectedAmountSats,
      fundedAmountSats,
      remainingAmountSats: expectedAmountSats - fundedAmountSats,
      overfundedAmountSats: 0,
    };
  }
  if (fundedAmountSats > expectedAmountSats) {
    return {
      state: "overfunded" as const,
      expectedAmountSats,
      fundedAmountSats,
      remainingAmountSats: 0,
      overfundedAmountSats: fundedAmountSats - expectedAmountSats,
    };
  }
  return {
    state: "funded" as const,
    expectedAmountSats,
    fundedAmountSats,
    remainingAmountSats: 0,
    overfundedAmountSats: 0,
  };
};
