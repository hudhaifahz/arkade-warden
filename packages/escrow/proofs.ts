export type ProofCoin = {
  txid: string;
  vout: number;
  value: number;
  script: string;
  isSpent?: boolean;
  isSwept?: boolean;
  spentBy?: string;
  settledBy?: string;
  commitmentTxIds?: string[];
  expiresAt?: Date;
};

export type SettlementProofSession = {
  stage: string;
  execution: string;
  input: { txid: string; vout: number; value: number; expiresAt?: string };
  destination: { script: string; value: number };
  result?: { commitmentTxid?: string };
};

export type ProofAssessment =
  | {
      verified: true;
      commitmentTxid: string;
      successor: { txid: string; vout: number; value: number; expiresAt?: string };
    }
  | { verified: false; reason: string };

const sameOutpoint = (
  coin: Pick<ProofCoin, "txid" | "vout">,
  outpoint: { txid: string; vout: number },
) => coin.txid === outpoint.txid && coin.vout === outpoint.vout;

const belongsToCommitment = (coin: ProofCoin, commitmentTxid: string) =>
  coin.settledBy === commitmentTxid || coin.commitmentTxIds?.includes(commitmentTxid) === true;

export const assessSettlementProof = ({
  session,
  commitmentExists,
  inputCoin,
  destinationCoins,
  requireSweptInput,
  requireLaterExpiry,
}: {
  session: SettlementProofSession;
  commitmentExists: boolean;
  inputCoin?: ProofCoin;
  destinationCoins: ProofCoin[];
  requireSweptInput: boolean;
  requireLaterExpiry: boolean;
}): ProofAssessment => {
  if (session.stage !== "completed") return { verified: false, reason: "session-not-completed" };
  const commitmentTxid = session.result?.commitmentTxid;
  if (!commitmentTxid) return { verified: false, reason: "commitment-id-missing" };
  if (!commitmentExists) return { verified: false, reason: "commitment-not-indexed" };
  if (!inputCoin || !sameOutpoint(inputCoin, session.input)) {
    return { verified: false, reason: "input-not-indexed" };
  }
  if (inputCoin.value !== session.input.value) return { verified: false, reason: "input-value-changed" };
  if (requireSweptInput && inputCoin.isSwept !== true) {
    return { verified: false, reason: "input-was-not-swept" };
  }
  if (inputCoin.isSpent !== true && !inputCoin.spentBy) {
    return { verified: false, reason: "input-not-consumed" };
  }

  const candidates = destinationCoins.filter(
    (coin) =>
      coin.script === session.destination.script &&
      coin.value === session.destination.value &&
      !sameOutpoint(coin, session.input) &&
      belongsToCommitment(coin, commitmentTxid),
  );
  if (candidates.length !== 1) {
    return { verified: false, reason: candidates.length === 0 ? "successor-not-found" : "successor-ambiguous" };
  }
  const [successor] = candidates;
  if (successor.isSpent || successor.spentBy || successor.isSwept) {
    return { verified: false, reason: "successor-not-live" };
  }
  if (requireLaterExpiry) {
    const priorExpiry = session.input.expiresAt ? Date.parse(session.input.expiresAt) : Number.NaN;
    const successorExpiry = successor.expiresAt?.getTime() ?? Number.NaN;
    if (!Number.isFinite(priorExpiry) || !Number.isFinite(successorExpiry) || successorExpiry <= priorExpiry) {
      return { verified: false, reason: "successor-expiry-not-extended" };
    }
  }
  return {
    verified: true,
    commitmentTxid,
    successor: {
      txid: successor.txid,
      vout: successor.vout,
      value: successor.value,
      expiresAt: successor.expiresAt?.toISOString(),
    },
  };
};
