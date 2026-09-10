import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import Header from '../../components/Header'
import Content from '../../components/Content'
import Padded from '../../components/Padded'
import FlexCol from '../../components/FlexCol'
import Button from '../../components/Button'
import Text, { TextSecondary } from '../../components/Text'
import ErrorMessage from '../../components/Error'
import LoadingLogo from '../../components/LoadingLogo'
import { WalletContext } from '../../providers/wallet'
import { AspContext } from '../../providers/asp'
import { getDefaultAddress } from '../../lib/address'

type EscrowVtxo = { txid: string; vout: number; value: number; expiresAt?: string }

type EscrowStatus = {
  contractId: string
  createdAt: string
  escrowAddress: string
  label?: string
  presetId?: string
  durationLabel?: string
  expectedAmountSats?: number
  fundedAmountSats: number
  fundingState: 'unbounded-legacy' | 'unfunded' | 'underfunded' | 'funded' | 'overfunded'
  remainingAmountSats?: number
  overfundedAmountSats?: number
  managed: boolean
  stockCompatible: boolean
  rolloverRequired: boolean
  parties: { buyerPubkey: string; sellerPubkey: string; arbiterPubkey: string }
  buyerControl: 'mobile-wallet' | 'local-keychain'
  buyerBound: boolean
  active: boolean
  expired: boolean
  signingInProgress: boolean
  rolloverSessionId?: string
  recoverySessionId?: string
  refundBlockHeight?: number
  refundAt?: string
  currentBlockHeight?: number
  remainingBlocks?: number
  remainingSeconds?: number
  earliestVtxoExpiry?: string
  expiresInSeconds?: number
  expiryRisk: 'safe' | 'warning' | 'critical' | 'recoverable'
  spendableVtxos: EscrowVtxo[]
  recoverableVtxos: EscrowVtxo[]
  rollover: {
    supported: boolean
    state: string
    execution: string
    warningThresholdSeconds?: number
    automaticExecution?: boolean
    quotedFeeSats?: number
    successorValue?: number
  }
  automaticRollover: {
    supported?: boolean
    state: string
    execution: string
    automaticExecution: boolean
    quotedFeeSats?: number
    input?: EscrowVtxo
    successor?: { address: string; value: number; refundAt: string }
    delegate?: { pubkey: string; feeSats: number; delegateAt: string }
    authorizationId?: string
    activationTest?: boolean
    replacesAuthorizationId?: string
  }
  recovery: {
    state: string
    execution: string
    mode?: 'mutual-preserve-escrow' | 'buyer-refund-after-expiry'
    input?: EscrowVtxo
    destination?: { address: string; script: string; value: number }
    quotedFeeSats?: number
    requiredApprovals?: string[]
  }
}

type RolloverSession = {
  sessionId: string
  contractId: string
  stage: 'queued' | 'running' | 'awaiting_mobile_signature' | 'completed' | 'failed'
  quotedFeeSats: number
  execution?: 'manual-stock-batch' | 'preauthorized-delegated-stock-batch'
  automaticExecution: boolean
  successor: { address: string; value: number; refundAt: string }
  delegate?: { pubkey: string; feeSats: number; delegateAt: string }
  request?: { requestId: string; purpose: string; psbt: string; inputIndexes: number[] }
  result?: { commitmentTxid?: string; authorizationId?: string; delegateAt?: string }
  error?: string
}

type RecoverySession = {
  sessionId: string
  contractId: string
  stage: 'queued' | 'running' | 'awaiting_mobile_signature' | 'completed' | 'failed'
  execution: 'mutual-preserve-escrow' | 'buyer-refund-after-expiry' | 'bounded-renewal-stock-batch'
  input: EscrowVtxo
  destination: { address: string; script: string; value: number }
  quotedFeeSats: number
  request?: { requestId: string; purpose: string; psbt: string; inputIndexes: number[] }
  result?: { commitmentTxid: string }
  error?: string
}

type HardenedMandateDraft = {
  sessionId: string
  digest: string
  expiresAt: string
  summary: {
    network: 'bitcoin'
    amountSats: number
    durationSeconds: number
    finalAt: string
    maxRenewals: number
    maxFeePerRolloverSats: number
    maxTotalFeeSats: number
    signerCount: number
    delegateCount: number
    recoveryModel: 'operator-independent-two-party-stock-exit'
    escrowAddress: string
  }
}

type WardenDashboard = {
  currentBlockHeight: number
  binding?: { buyerArkadeAddress: string }
  contracts: EscrowStatus[]
  presets: {
    id: string
    label: string
    durationSeconds: number
    rolloverRequired: boolean
    creationEnabled: boolean
    disabledReason?: string
  }[]
  activationGates: {
    fundedManualRollover: { verified: boolean }
    expiryRecoveryDrill: { verified: boolean }
    automaticLongTerm: { enabled: boolean }
  }
  proofAudit: {
    manualRollover: { verified: boolean; reason?: string }
    expiryRecovery: { verified: boolean; reason?: string }
  }
  seller: {
    address: string
    destinationArkadeAddress?: string
    earliestVtxoExpiry?: string
    expiresInSeconds?: number
    expiryRisk: 'safe' | 'warning' | 'critical' | 'recoverable'
    spendableVtxos: EscrowVtxo[]
    recoverableVtxos: EscrowVtxo[]
  }
  protection: {
    warningThresholdSeconds: number
    criticalThresholdSeconds: number
    unilateralExitDelaySeconds: number
    policy: string
  }
}

const cardStyle = {
  border: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
  borderRadius: '1rem',
  background: 'color-mix(in srgb, var(--fg) 3%, var(--bg))',
  padding: '1rem',
} as const

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.75rem',
  overflowWrap: 'anywhere',
} as const

const warningStyle = {
  ...cardStyle,
  borderColor: 'color-mix(in srgb, var(--yellow-700, #d97706) 55%, transparent)',
  color: 'var(--yellow-700, #b45309)',
} as const

const dangerStyle = {
  ...cardStyle,
  borderColor: 'color-mix(in srgb, var(--red-700, #b91c1c) 55%, transparent)',
  color: 'var(--red-700, #b91c1c)',
} as const

const requestJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (response.status === 401) {
    window.location.href = '/login'
    throw new Error('Owner login required')
  }
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Warden request failed')
  return body
}

const totalSats = (vtxos: EscrowVtxo[]) => vtxos.reduce((sum, vtxo) => sum + Number(vtxo.value), 0)

const timeLeft = (seconds?: number) => {
  if (seconds === undefined) return 'No funded VTXO'
  if (seconds <= 0) return 'Arkade batch window has expired'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  if (days > 0) return `${days}d ${hours}h until Arkade expiry`
  const minutes = Math.max(1, Math.floor((seconds % 3_600) / 60))
  return `${hours}h ${minutes}m until Arkade expiry`
}

const refundTimeLeft = (seconds?: number) => {
  if (seconds === undefined) return 'Refund timing unavailable'
  if (seconds <= 0) return 'Buyer refund is unlocked'
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.max(1, Math.floor((seconds % 3_600) / 60))
  return `${hours}h ${minutes}m until buyer refund unlocks`
}

const rolloverText = (state: string) => {
  if (state === 'not-due') return 'Stock-batch rollover is monitored and not due.'
  if (state === 'ready-for-mutual-signing') return 'Rollover window reached: buyer and seller approval are required.'
  if (state === 'available-for-activation-test')
    return 'Rollover is not required for safety, but this tiny funded escrow can prove the stock-batch path.'
  if (state === 'recover-first') return 'This VTXO must be recovered before any rollover.'
  if (state === 'bounded-mandate-controls-renewal')
    return 'Automatic stock-batch renewal is controlled by the jointly approved bounded mandate.'
  return ''
}

export default function Warden() {
  const { svcWallet } = useContext(WalletContext)
  const { aspInfo } = useContext(AspContext)
  const [dashboard, setDashboard] = useState<WardenDashboard>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState('')
  const [rolloverSessionId, setRolloverSessionId] = useState(() => localStorage.getItem('fc-warden-rollover-session') ?? '')
  const [recoverySessionId, setRecoverySessionId] = useState(() => localStorage.getItem('fc-warden-recovery-session') ?? '')
  const drivingRollover = useRef(false)
  const drivingRecovery = useRef(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const next = await requestJson<WardenDashboard>('/owner/api/warden/dashboard')
      setDashboard(next)
      const pendingRollover = next.contracts.find((contract) => contract.rolloverSessionId)?.rolloverSessionId
      if (pendingRollover) {
        localStorage.setItem('fc-warden-rollover-session', pendingRollover)
        setRolloverSessionId(pendingRollover)
      }
      const pendingRecovery = next.contracts.find((contract) => contract.recoverySessionId)?.recoverySessionId
      if (pendingRecovery) {
        localStorage.setItem('fc-warden-recovery-session', pendingRecovery)
        setRecoverySessionId(pendingRecovery)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Warden')
    }
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const driveRollover = useCallback(
    async (sessionId: string) => {
      if (!svcWallet || drivingRollover.current) return
      drivingRollover.current = true
      setBusy('rollover')
      setError('')
      try {
        for (;;) {
          const session = await requestJson<RolloverSession>(`/owner/api/warden/rollover/${sessionId}`)
          if (session.stage === 'completed') {
            localStorage.removeItem('fc-warden-rollover-session')
            setRolloverSessionId('')
            setResult(
              session.execution === 'preauthorized-delegated-stock-batch'
                ? `Automatic rollover preauthorized for ${session.result?.delegateAt ? new Date(session.result.delegateAt).toLocaleString() : 'the protected window'}. Authorization ${session.result?.authorizationId ?? session.sessionId}`
                : `Escrow rolled into a fresh stock Arkade batch. Commitment ${session.result?.commitmentTxid ?? ''}`,
            )
            await load()
            return
          }
          if (session.stage === 'failed') {
            localStorage.removeItem('fc-warden-rollover-session')
            setRolloverSessionId('')
            throw new Error(session.error ?? 'Rollover failed')
          }
          if (session.stage === 'awaiting_mobile_signature' && session.request) {
            const approved = window.confirm(
              `Approve ${session.request.purpose.replaceAll('-', ' ')}?\n\nContract: ${session.contractId}\nSuccessor: ${session.successor.value.toLocaleString()} sats\nFee: ${session.quotedFeeSats.toLocaleString()} sats\nRefund deadline remains ${new Date(session.successor.refundAt).toLocaleString()}.\n\nThe signed transaction is checked against this exact stock-batch plan.`,
            )
            if (!approved) {
              setResult('Rollover paused before signing. Use Resume rollover within 30 minutes to continue.')
              return
            }
            const prepared = Transaction.fromPSBT(base64.decode(session.request.psbt))
            const signed = await svcWallet.identity.sign(prepared, session.request.inputIndexes)
            await requestJson(`/owner/api/warden/rollover/${sessionId}/sign`, {
              method: 'POST',
              body: JSON.stringify({
                requestId: session.request.requestId,
                signedPsbt: base64.encode(signed.toPSBT()),
              }),
            })
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to complete rollover')
      } finally {
        drivingRollover.current = false
        setBusy('')
      }
    },
    [load, svcWallet],
  )

  const driveRecovery = useCallback(
    async (sessionId: string) => {
      if (!svcWallet || drivingRecovery.current) return
      drivingRecovery.current = true
      setBusy('recovery')
      setError('')
      try {
        for (;;) {
          const session = await requestJson<RecoverySession>(`/owner/api/warden/recovery/${sessionId}`)
          if (session.stage === 'completed') {
            localStorage.removeItem('fc-warden-recovery-session')
            setRecoverySessionId('')
            setResult(
              `${session.destination.value.toLocaleString()} sats recovered ${
                session.execution === 'buyer-refund-after-expiry'
                  ? 'to this buyer wallet'
                  : 'into a fresh copy of the same escrow'
              }. Commitment ${session.result?.commitmentTxid ?? ''}`,
            )
            await load()
            return
          }
          if (session.stage === 'failed') {
            localStorage.removeItem('fc-warden-recovery-session')
            setRecoverySessionId('')
            throw new Error(session.error ?? 'Expiry recovery failed')
          }
          if (session.stage === 'awaiting_mobile_signature' && session.request) {
            const approved = window.confirm(
              `Approve ${session.request.purpose.replaceAll('-', ' ')}?\n\nContract: ${session.contractId}\nRecovered value: ${session.destination.value.toLocaleString()} sats\nFee: ${session.quotedFeeSats.toLocaleString()} sats\nDestination: ${session.destination.address}\n\nThe server checks the exact swept input, destination, amount, and fee before submitting through stock arkd.`,
            )
            if (!approved) {
              setResult('Recovery paused before signing. Use Resume expiry recovery within 30 minutes to continue.')
              return
            }
            const prepared = Transaction.fromPSBT(base64.decode(session.request.psbt))
            const signed = await svcWallet.identity.sign(prepared, session.request.inputIndexes)
            await requestJson(`/owner/api/warden/recovery/${sessionId}/sign`, {
              method: 'POST',
              body: JSON.stringify({
                requestId: session.request.requestId,
                signedPsbt: base64.encode(signed.toPSBT()),
              }),
            })
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to complete expiry recovery')
      } finally {
        drivingRecovery.current = false
        setBusy('')
      }
    },
    [load, svcWallet],
  )

  const bindWallet = async () => {
    if (!svcWallet) return setError('Wallet is not unlocked')
    setBusy('binding')
    setError('')
    setResult('')
    try {
      const buyerPubkey = hex.encode(await svcWallet.identity.xOnlyPublicKey())
      const buyerArkadeAddress = getDefaultAddress(buyerPubkey, aspInfo)
      await requestJson('/owner/api/warden/bind', {
        method: 'POST',
        body: JSON.stringify({ buyerPubkey, buyerArkadeAddress }),
      })
      setResult('This wallet is now the buyer and seller-proceeds destination for new Warden actions.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to bind wallet')
    } finally {
      setBusy('')
    }
  }

  const createEscrow = async (preset: WardenDashboard['presets'][number]) => {
    if (!svcWallet) return setError('Wallet is not ready')
    if (!preset.creationEnabled) return setError(preset.disabledReason ?? 'This duration is not enabled yet')
    const amountText = window.prompt(`Expected escrow amount for ${preset.label} (sats)`, '1000')
    if (amountText === null) return
    const expectedAmountSats = Number(amountText.replaceAll(',', '').trim())
    if (!Number.isSafeInteger(expectedAmountSats) || expectedAmountSats <= 0) {
      return setError('Expected escrow amount must be a positive whole number of sats')
    }
    if (
      !window.confirm(
        `Create a new ${preset.label} Warden escrow for exactly ${expectedAmountSats.toLocaleString()} sats?\n\nRelease stays disabled unless funding matches that amount exactly. Extra deposits are frozen for review. Creating it does not move any sats.`,
      )
    )
      return
    setBusy(`create:${preset.id}`)
    setError('')
    setResult('')
    try {
      const buyerPubkey = hex.encode(await svcWallet.identity.xOnlyPublicKey())
      const created = await requestJson<EscrowStatus>('/owner/api/warden/contracts', {
        method: 'POST',
        body: JSON.stringify({ presetId: preset.id, buyerPubkey, expectedAmountSats }),
      })
      setResult(`${preset.label} escrow created. Contract ${created.contractId}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create escrow')
    } finally {
      setBusy('')
    }
  }

  const createHardenedAlphaEscrow = async () => {
    if (!svcWallet) return setError('Wallet is not ready')
    if (!dashboard?.binding) return setError('Bind this mobile wallet first')
    if (
      !window.confirm(
        'Prepare a fresh 10-day mainnet-alpha escrow for exactly 1,000 sats?\n\nThis creates an address but moves no sats. You will review one bounded mandate covering up to four stock renewals, two renewal signers, two delegates, fixed destination, fixed parties, and a fixed final date.',
      )
    )
      return
    setBusy('create:hardened-alpha')
    setError('')
    setResult('')
    try {
      const draft = await requestJson<HardenedMandateDraft>('/owner/api/warden/hardened/draft', {
        method: 'POST',
        body: JSON.stringify({ durationSeconds: 10 * 24 * 60 * 60, expectedAmountSats: 1_000 }),
      })
      const days = Math.round(draft.summary.durationSeconds / 86_400)
      if (
        !window.confirm(
          `Authorize this bounded renewal mandate?\n\nNetwork: Bitcoin mainnet alpha\nEscrow: 1,000 sats for ${days} days\nFinal date: ${new Date(draft.summary.finalAt).toLocaleString()}\nMaximum renewals: ${draft.summary.maxRenewals}\nMaximum fee each: ${draft.summary.maxFeePerRolloverSats} sats\nMaximum fees total: ${draft.summary.maxTotalFeeSats} sats\nIndependent renewal signers: ${draft.summary.signerCount}\nIndependent delegates: ${draft.summary.delegateCount}\nRecovery: any approved two of buyer, seller, and arbiter can exit without the operator after Arkade's delay\n\nEvery renewal must keep the same address, script, parties, value except the capped fee, and final date. This approval expires in 30 minutes.`,
        )
      ) {
        setResult('Hardened mandate draft was not signed. No escrow was activated and no sats moved.')
        return
      }
      const signature = await svcWallet.identity.signMessage(hex.decode(draft.digest), 'schnorr')
      const approved = await requestJson<{ contract: { contractId: string; escrowAddress: string } }>(
        '/owner/api/warden/hardened/approve',
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: draft.sessionId, buyerSignature: hex.encode(signature) }),
        },
      )
      setResult(`Hardened alpha escrow approved. Contract ${approved.contract.contractId}. Fund only after its status appears below.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create hardened alpha escrow')
    } finally {
      setBusy('')
    }
  }

  const startRollover = async (contract: EscrowStatus) => {
    if (!svcWallet) return setError('Wallet is not ready')
    const value = totalSats(contract.spendableVtxos)
    const fee = contract.rollover.quotedFeeSats
    const successorValue = contract.rollover.successorValue
    const activationTest = contract.rollover.state === 'available-for-activation-test'
    if (fee === undefined || successorValue === undefined) return setError('Refresh to obtain a stock rollover quote')
    if (
      !window.confirm(
        `${activationTest ? 'Run the tiny funded rollover activation test' : 'Start mutual stock-batch rollover'}?\n\nCurrent escrow: ${value.toLocaleString()} sats\nFresh escrow: ${successorValue.toLocaleString()} sats\nMaximum fee: ${fee.toLocaleString()} sats\nContract: ${contract.contractId}\n\nThe address, parties, and refund deadline stay unchanged. Your phone will ask before every required signature.`,
      )
    )
      return
    setBusy('rollover')
    setError('')
    setResult('')
    try {
      const session = await requestJson<RolloverSession>('/owner/api/warden/rollover/start', {
        method: 'POST',
        body: JSON.stringify({
          contractId: contract.contractId,
          confirmContractId: contract.contractId,
          expectedInputValue: value,
          expectedFeeSats: fee,
          maxFeeSats: fee,
        }),
      })
      localStorage.setItem('fc-warden-rollover-session', session.sessionId)
      setRolloverSessionId(session.sessionId)
      await driveRollover(session.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start rollover')
      setBusy('')
    }
  }

  const preauthorizeRollover = async (contract: EscrowStatus, activationTest = false) => {
    if (!svcWallet) return setError('Wallet is not ready')
    const plan = contract.automaticRollover
    if (!plan.input || !plan.successor || !plan.delegate || plan.quotedFeeSats === undefined) {
      return setError(`Automatic rollover is unavailable: ${plan.state}`)
    }
    if (
      !window.confirm(
        `${activationTest ? 'Replace the day-3 authorization and test automatic rollover now?' : 'Preauthorize one automatic rollover?'}\n\nInput: ${plan.input.value.toLocaleString()} sats\nSuccessor: ${plan.successor.value.toLocaleString()} sats\nMaximum fee: ${plan.quotedFeeSats.toLocaleString()} sats\nNot before: ${new Date(plan.delegate.delegateAt).toLocaleString()}\nContract: ${contract.contractId}\n\nThe buyer and seller will sign the exact input, destination, fee cap, parties, and original refund deadline now. ${activationTest ? 'Fulmine will cancel the older pending task for this same input before accepting this replacement. ' : ''}The Fulmine delegate can submit only that signed package through stock arkd.`,
      )
    )
      return
    setBusy('rollover')
    setError('')
    setResult('')
    try {
      const session = await requestJson<RolloverSession>('/owner/api/warden/rollover/preauthorize', {
        method: 'POST',
        body: JSON.stringify({
          contractId: contract.contractId,
          confirmContractId: contract.contractId,
          expectedInputValue: plan.input.value,
          expectedFeeSats: plan.quotedFeeSats,
          maxFeeSats: plan.quotedFeeSats,
          expectedDelegateAt: plan.delegate.delegateAt,
          activationTest,
          replacesAuthorizationId: plan.replacesAuthorizationId,
        }),
      })
      localStorage.setItem('fc-warden-rollover-session', session.sessionId)
      setRolloverSessionId(session.sessionId)
      await driveRollover(session.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to preauthorize automatic rollover')
      setBusy('')
    }
  }

  const startRecovery = async (contract: EscrowStatus) => {
    if (!svcWallet) return setError('Wallet is not ready')
    const plan = contract.recovery
    if (!plan.input || !plan.destination || plan.quotedFeeSats === undefined || !plan.mode) {
      return setError(`Expiry recovery is unavailable: ${plan.state}`)
    }
    const destinationMeaning =
      plan.mode === 'buyer-refund-after-expiry'
        ? 'your recorded buyer wallet because the Warden refund deadline has passed'
        : 'a fresh VTXO at the exact same escrow address because the Warden agreement is still active'
    if (
      !window.confirm(
        `Recover this swept escrow through a stock Arkade batch?\n\nSwept input: ${plan.input.value.toLocaleString()} sats\nRecovered value: ${plan.destination.value.toLocaleString()} sats\nMaximum fee: ${plan.quotedFeeSats.toLocaleString()} sats\nDestination: ${plan.destination.address}\n\nThe destination is ${destinationMeaning}. Your phone will approve every required signature.`,
      )
    )
      return
    setBusy('recovery')
    setError('')
    setResult('')
    try {
      const session = await requestJson<RecoverySession>('/owner/api/warden/recovery/start', {
        method: 'POST',
        body: JSON.stringify({
          contractId: contract.contractId,
          confirmContractId: contract.contractId,
          expectedInputValue: plan.input.value,
          expectedDestination: plan.destination.address,
          expectedDestinationValue: plan.destination.value,
          expectedFeeSats: plan.quotedFeeSats,
          maxFeeSats: plan.quotedFeeSats,
        }),
      })
      localStorage.setItem('fc-warden-recovery-session', session.sessionId)
      setRecoverySessionId(session.sessionId)
      await driveRecovery(session.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start expiry recovery')
      setBusy('')
    }
  }

  const signAction = async (action: 'release' | 'refund' | 'migrate', contract: EscrowStatus) => {
    if (!svcWallet) return setError('Wallet is not ready')
    const value = totalSats(contract.spendableVtxos)
    const depositCount = contract.spendableVtxos.length
    const verb =
      action === 'refund'
        ? 'refund to this mobile wallet'
        : action === 'migrate'
          ? 'move into the Fulmine-compatible stock escrow'
          : 'release to the seller'
    if (
      !window.confirm(
        `Sign ${verb}?\n\nContract: ${contract.contractId}\nDeposits: ${depositCount}\nAmount: ${value.toLocaleString()} sats\n\nAll listed deposits are spent atomically in one real mainnet Arkade transaction.`,
      )
    )
      return
    setBusy(`${action}:${contract.contractId}`)
    setError('')
    setResult('')
    try {
      const prepared = await requestJson<{
        sessionId: string
        arkTx: string
        value: number
        destinationContractId?: string
        destinationAddress?: string
      }>(
        '/owner/api/warden/prepare',
        {
          method: 'POST',
          body: JSON.stringify({ action, contractId: contract.contractId }),
        },
      )
      const signedArkTx = await svcWallet.identity.sign(Transaction.fromPSBT(base64.decode(prepared.arkTx)))
      const submitted = await requestJson<{ sessionId: string; checkpoints: string[] }>(
        '/owner/api/warden/submit-ark',
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: prepared.sessionId, signedArkTx: base64.encode(signedArkTx.toPSBT()) }),
        },
      )
      const signedCheckpoints = await Promise.all(
        submitted.checkpoints.map(async (checkpoint) => {
          const signed = await svcWallet.identity.sign(Transaction.fromPSBT(base64.decode(checkpoint)), [0])
          return base64.encode(signed.toPSBT())
        }),
      )
      const finalized = await requestJson<{
        result: string
        arkTxid: string
        value: number
        destinationContractId?: string
        destinationAddress?: string
      }>(
        '/owner/api/warden/finalize',
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: submitted.sessionId, signedCheckpoints }),
        },
      )
      setResult(
        `${finalized.value.toLocaleString()} sats ${finalized.result}. Transaction ${finalized.arkTxid}${
          finalized.destinationContractId ? ` · corrected contract ${finalized.destinationContractId}` : ''
        }`,
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${action} escrow`)
    } finally {
      setBusy('')
    }
  }

  const claimSeller = async () => {
    if (!dashboard?.seller.destinationArkadeAddress) return setError('Bind this mobile wallet first')
    const value = totalSats(dashboard.seller.spendableVtxos)
    if (
      !window.confirm(
        `Claim seller proceeds to this mobile Arkade wallet?\n\nAmount: ${value.toLocaleString()} sats\nDestination: ${dashboard.seller.destinationArkadeAddress}\n\nThis submits a real mainnet Arkade transaction using the seller key held in your Mac Keychain.`,
      )
    )
      return
    setBusy('claim-seller')
    setError('')
    setResult('')
    try {
      const claimed = await requestJson<{ value: number; arkTxid: string }>('/owner/api/warden/claim-seller', {
        method: 'POST',
        body: JSON.stringify({
          destinationArkadeAddress: dashboard.seller.destinationArkadeAddress,
          expectedValue: value,
        }),
      })
      setResult(`${claimed.value.toLocaleString()} seller sats claimed to this wallet. Transaction ${claimed.arkTxid}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to claim seller proceeds')
    } finally {
      setBusy('')
    }
  }

  const recoverSeller = async () => {
    const value = totalSats(dashboard?.seller.recoverableVtxos ?? [])
    if (
      !window.confirm(
        `Recover expired seller proceeds through a new Arkade round?\n\nGross amount: ${value.toLocaleString()} sats\n\nThe operator may deduct configured settlement fees. After recovery, use Claim seller proceeds to move the resulting VTXO to this mobile wallet.`,
      )
    )
      return
    setBusy('recover-seller')
    setError('')
    setResult('')
    try {
      const recovered = await requestJson<{ recoveredValue: number; arkTxid: string }>(
        '/owner/api/warden/recover-seller',
        {
          method: 'POST',
          body: JSON.stringify({ expectedValue: value }),
        },
      )
      setResult(
        `${recovered.recoveredValue.toLocaleString()} seller sats recovered into a fresh seller VTXO. Transaction ${recovered.arkTxid}`,
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recover seller proceeds')
    } finally {
      setBusy('')
    }
  }

  const visibleContracts = useMemo(
    () =>
      dashboard?.contracts.filter(
        (contract) =>
          contract.managed || contract.active || contract.spendableVtxos.length > 0 || contract.recoverableVtxos.length > 0,
      ) ?? [],
    [dashboard],
  )

  if (!dashboard && !error) return <LoadingLogo text='Loading Warden...' />
  const sellerValue = totalSats(dashboard?.seller.spendableVtxos ?? [])
  const sellerRecoverable = totalSats(dashboard?.seller.recoverableVtxos ?? [])
  const archivedEmpty =
    dashboard?.contracts.filter(
      (contract) => !contract.active && contract.spendableVtxos.length === 0 && contract.recoverableVtxos.length === 0,
    ).length ?? 0
  const atRisk = visibleContracts.filter((contract) => contract.expiryRisk !== 'safe')
  const sellerAtRisk = Boolean(dashboard && dashboard.seller.expiryRisk !== 'safe')

  return (
    <>
      <Header text='Warden escrows' back />
      <Content noRefresh>
        <Padded>
          <FlexCol gap='1rem'>
            <ErrorMessage error={Boolean(error)} text={error} />
            {result ? <div style={{ ...cardStyle, color: 'var(--green-700)' }}>{result}</div> : null}
            {rolloverSessionId ? (
              <div style={warningStyle}>
                <FlexCol gap='0.6rem'>
                  <Text bold>Mutual rollover in progress</Text>
                  <TextSecondary>
                    The stock batch may be waiting for another phone signature. Resume before the 30-minute session expires.
                  </TextSecondary>
                  <Button
                    label='Resume rollover'
                    loading={busy === 'rollover'}
                    disabled={Boolean(busy) || !svcWallet}
                    onClick={() => driveRollover(rolloverSessionId)}
                  />
                </FlexCol>
              </div>
            ) : null}
            {recoverySessionId ? (
              <div style={dangerStyle}>
                <FlexCol gap='0.6rem'>
                  <Text bold>Expiry recovery in progress</Text>
                  <TextSecondary>
                    The stock recovery batch may be waiting for a phone signature. Resume before the 30-minute session
                    expires.
                  </TextSecondary>
                  <Button
                    label='Resume expiry recovery'
                    loading={busy === 'recovery'}
                    disabled={Boolean(busy) || !svcWallet}
                    onClick={() => driveRecovery(recoverySessionId)}
                  />
                </FlexCol>
              </div>
            ) : null}
            {atRisk.length > 0 || sellerAtRisk ? (
              <div
                style={
                  atRisk.some((contract) => contract.expiryRisk === 'recoverable') ||
                  dashboard?.seller.expiryRisk === 'recoverable'
                    ? dangerStyle
                    : warningStyle
                }
              >
                <Text bold>Expiry attention required</Text>
                <TextSecondary>
                  Funded escrows need refund or release, and seller proceeds need claim, before leaving the spendable window.
                  Recoverable funds are retained in this dashboard and never auto-rotated.
                </TextSecondary>
              </div>
            ) : null}
            <div style={cardStyle}>
              <FlexCol gap='0.5rem'>
                <Text bold>Mobile wallet binding</Text>
                <TextSecondary>
                  Refund signatures happen on this device. Seller proceeds can only sweep to the currently bound mobile
                  Arkade address.
                </TextSecondary>
                {dashboard?.binding?.buyerArkadeAddress ? (
                  <div style={monoStyle}>{dashboard.binding.buyerArkadeAddress}</div>
                ) : null}
                <Button
                  label={dashboard?.binding ? 'Re-bind this wallet for future escrows' : 'Bind this wallet'}
                  loading={busy === 'binding'}
                  disabled={Boolean(busy)}
                  onClick={bindWallet}
                />
              </FlexCol>
            </div>
            <div style={cardStyle}>
              <FlexCol gap='0.75rem'>
                <Text bold>Create an independent escrow</Text>
                <TextSecondary>
                  Each escrow gets a unique address, parties, contract ID, refund deadline, and rollover status. Creating
                  one does not move funds.
                </TextSecondary>
                {dashboard?.presets.map((preset) => (
                  <div key={preset.id} style={preset.creationEnabled ? cardStyle : warningStyle}>
                    <FlexCol gap='0.45rem'>
                      <Text bold>{preset.label}</Text>
                      <TextSecondary>
                        {preset.rolloverRequired ? 'Rollover required.' : 'No rollover normally required.'}
                        {!preset.creationEnabled ? ` ${preset.disabledReason}.` : ''}
                      </TextSecondary>
                      <Button
                        label={preset.creationEnabled ? `Create ${preset.label} escrow` : `${preset.label} locked by test gate`}
                        variant='secondary'
                        loading={busy === `create:${preset.id}`}
                        disabled={Boolean(busy) || !preset.creationEnabled || !dashboard.binding}
                        onClick={() => createEscrow(preset)}
                      />
                    </FlexCol>
                  </div>
                ))}
              </FlexCol>
            </div>
            <div style={cardStyle}>
              <FlexCol gap='0.75rem'>
                <Text bold>Hardened automatic-renewal alpha</Text>
                <TextSecondary>
                  Creates one isolated 10-day, 1,000-sat mainnet-alpha escrow. One buyer approval fixes the final date,
                  address, parties, renewal count, and fee ceilings. Two signer paths and two delegate paths are included,
                  alongside three stock-compatible, operator-independent two-party exit paths. No single party can use
                  those exits to bypass the escrow. Creating it does not move sats.
                </TextSecondary>
                <Button
                  label='Create hardened 10-day alpha escrow'
                  variant='secondary'
                  loading={busy === 'create:hardened-alpha'}
                  disabled={Boolean(busy) || !dashboard?.binding}
                  onClick={createHardenedAlphaEscrow}
                />
              </FlexCol>
            </div>
            <div style={dashboard?.activationGates.automaticLongTerm.enabled ? cardStyle : warningStyle}>
              <FlexCol gap='0.5rem'>
                <Text bold>Long-term activation proof</Text>
                <TextSecondary>
                  {dashboard?.activationGates.fundedManualRollover.verified ? '✓' : '○'} Tiny funded manual rollover
                </TextSecondary>
                <TextSecondary>
                  {dashboard?.activationGates.expiryRecoveryDrill.verified ? '✓' : '○'} Swept-VTXO expiry recovery
                </TextSecondary>
                <TextSecondary>
                  {dashboard?.activationGates.automaticLongTerm.enabled
                    ? 'Long-term creation and mutually preauthorized delegated rollover are enabled.'
                    : 'Seven-day and longer creation will unlock automatically only after both results are independently visible in the stock Arkade index.'}
                </TextSecondary>
              </FlexCol>
            </div>
            <div style={cardStyle}>
              <FlexCol gap='0.6rem'>
                <Text bold>Seller proceeds</Text>
                <Text>{sellerValue.toLocaleString()} spendable sats</Text>
                <TextSecondary>
                  Release creates a seller VTXO first. Claim moves all seller proceeds to the bound mobile wallet without
                  exporting the Mac Keychain seed.
                </TextSecondary>
                {sellerValue > 0 ? (
                  <TextSecondary>
                    {timeLeft(dashboard?.seller.expiresInSeconds)}
                    {dashboard?.seller.earliestVtxoExpiry
                      ? ` · ${new Date(dashboard.seller.earliestVtxoExpiry).toLocaleString()}`
                      : ''}
                  </TextSecondary>
                ) : null}
                {sellerRecoverable > 0 ? (
                  <div style={dangerStyle}>
                    {sellerRecoverable.toLocaleString()} seller sats are recoverable rather than spendable. Recover them into
                    a fresh seller VTXO, then claim them to this wallet.
                  </div>
                ) : null}
                <Button
                  label='Recover expired seller proceeds'
                  variant='secondary'
                  loading={busy === 'recover-seller'}
                  disabled={Boolean(busy) || sellerRecoverable === 0}
                  onClick={recoverSeller}
                />
                <Button
                  label='Claim seller proceeds to this wallet'
                  loading={busy === 'claim-seller'}
                  disabled={Boolean(busy) || sellerValue === 0 || !dashboard?.binding || sellerRecoverable > 0}
                  onClick={claimSeller}
                />
              </FlexCol>
            </div>
            <FlexCol gap='0.75rem'>
              <Text bold>Refunds and active contracts</Text>
              {visibleContracts.map((contract) => {
                const escrowValue = totalSats(contract.spendableVtxos)
                const recoverableValue = totalSats(contract.recoverableVtxos)
                const mobileControlled = contract.buyerControl === 'mobile-wallet'
                const busyRelease = busy === `release:${contract.contractId}`
                const busyRefund = busy === `refund:${contract.contractId}`
                const busyMigrate = busy === `migrate:${contract.contractId}`
                const canRollover =
                  contract.rollover.state === 'ready-for-mutual-signing' ||
                  contract.rollover.state === 'not-due' ||
                  contract.rollover.state === 'available-for-activation-test'
                return (
                  <div
                    key={contract.contractId}
                    style={
                      contract.expiryRisk === 'recoverable'
                        ? dangerStyle
                        : contract.expiryRisk === 'critical' || contract.expiryRisk === 'warning'
                          ? warningStyle
                          : cardStyle
                    }
                  >
                    <FlexCol gap='0.6rem'>
                      <Text bold>
                        {contract.label ? `${contract.label} · ` : ''}
                        {escrowValue.toLocaleString()} sats locked{contract.active ? ' · legacy active' : ''}
                      </Text>
                      {contract.durationLabel ? (
                        <TextSecondary>
                          {contract.durationLabel} preset · {contract.rolloverRequired ? 'rollover required' : 'short-term'}
                        </TextSecondary>
                      ) : null}
                      {contract.expectedAmountSats !== undefined ? (
                        <div style={contract.fundingState === 'funded' ? cardStyle : warningStyle}>
                          <TextSecondary>
                            Contract amount: {contract.expectedAmountSats.toLocaleString()} sats · funded:{' '}
                            {contract.fundedAmountSats.toLocaleString()} sats.
                          </TextSecondary>
                          {contract.fundingState === 'underfunded' || contract.fundingState === 'unfunded' ? (
                            <TextSecondary>
                              Release locked: {(contract.remainingAmountSats ?? 0).toLocaleString()} sats still required.
                            </TextSecondary>
                          ) : null}
                          {contract.fundingState === 'overfunded' ? (
                            <TextSecondary>
                              Release frozen: {(contract.overfundedAmountSats ?? 0).toLocaleString()} excess sats require
                              independent review. The buyer cannot pull principal back before expiry.
                            </TextSecondary>
                          ) : null}
                        </div>
                      ) : (
                        <TextSecondary>Early experimental contract: no fixed funding amount was recorded.</TextSecondary>
                      )}
                      <TextSecondary>
                        {contract.expired
                          ? 'Buyer refund is unlocked.'
                          : contract.refundBlockHeight
                            ? `${contract.remainingBlocks} blocks until buyer refund height ${contract.refundBlockHeight}.`
                            : `${refundTimeLeft(contract.remainingSeconds)} · ${contract.refundAt ? new Date(contract.refundAt).toLocaleString() : 'time lock'}.`}
                      </TextSecondary>
                      {escrowValue > 0 ? (
                        <TextSecondary>
                          {timeLeft(contract.expiresInSeconds)}
                          {contract.earliestVtxoExpiry
                            ? ` · ${new Date(contract.earliestVtxoExpiry).toLocaleString()}`
                            : ''}
                        </TextSecondary>
                      ) : null}
                      {contract.spendableVtxos.length > 1 ? (
                        <TextSecondary>
                          {contract.spendableVtxos.length} deposits are locked here ({escrowValue.toLocaleString()} sats
                          total). They release or refund atomically; there is no buyer-triggered pre-expiry return.
                        </TextSecondary>
                      ) : null}
                      {escrowValue > 0 && rolloverText(contract.rollover.state) ? (
                        <TextSecondary>{rolloverText(contract.rollover.state)}</TextSecondary>
                      ) : null}
                      {!contract.stockCompatible && escrowValue > 0 ? (
                        <div style={dangerStyle}>
                          This early experimental escrow is rejected by stock arkd’s closure parser. Do not fund it again.
                          Recover its existing VTXO, then use a new stock-closure hardened escrow.
                        </div>
                      ) : null}
                      {contract.automaticRollover.state === 'fulmine-script-migration-required' && escrowValue > 0 ? (
                        <div style={warningStyle}>
                          This escrow predates stock Fulmine’s one-owner delegation format. Its funds are safe, but automatic
                          rollover requires a signed migration that preserves the parties, value, and refund deadline.
                        </div>
                      ) : null}
                      {canRollover && contract.rollover.quotedFeeSats !== undefined ? (
                        <TextSecondary>
                          Stock rollover quote: {contract.rollover.quotedFeeSats.toLocaleString()} sats. Successor:{' '}
                          {contract.rollover.successorValue?.toLocaleString()} sats.
                        </TextSecondary>
                      ) : null}
                      {recoverableValue > 0 ? (
                        <div style={dangerStyle}>
                          {recoverableValue.toLocaleString()} sats require operator-assisted Arkade recovery. This contract is
                          protected from automatic rotation.
                        </div>
                      ) : null}
                      {recoverableValue > 0 ? (
                        <TextSecondary>
                          {contract.recovery.mode === 'buyer-refund-after-expiry'
                            ? 'Recovery destination: this buyer wallet; the Warden refund deadline has passed.'
                            : contract.recovery.mode === 'mutual-preserve-escrow'
                              ? 'Recovery destination: the same escrow; the Warden agreement is still active.'
                              : `Recovery state: ${contract.recovery.state}.`}
                        </TextSecondary>
                      ) : null}
                      <div style={monoStyle}>{contract.escrowAddress}</div>
                      <TextSecondary>Contract {contract.contractId}</TextSecondary>
                      <TextSecondary>
                        Buyer {contract.parties.buyerPubkey.slice(0, 12)}… · Seller {contract.parties.sellerPubkey.slice(0, 12)}…
                        · Arbiter {contract.parties.arbiterPubkey.slice(0, 12)}…
                      </TextSecondary>
                      <Button
                        label='Release to seller'
                        loading={busyRelease}
                        disabled={
                          Boolean(busy) ||
                          !mobileControlled ||
                          escrowValue === 0 ||
                          recoverableValue > 0 ||
                          (contract.expectedAmountSats !== undefined && contract.fundingState !== 'funded')
                        }
                        onClick={() => signAction('release', contract)}
                      />
                      <Button
                        label='Refund to this wallet'
                        variant='secondary'
                        loading={busyRefund}
                        disabled={
                          Boolean(busy) || !mobileControlled || !contract.expired || escrowValue === 0 || recoverableValue > 0
                        }
                        onClick={() => signAction('refund', contract)}
                      />
                      <Button
                        label='Migrate to Fulmine-compatible escrow'
                        variant='secondary'
                        loading={busyMigrate}
                        disabled={
                          Boolean(busy) ||
                          !mobileControlled ||
                          !contract.managed ||
                          (contract.stockCompatible &&
                            contract.automaticRollover.state !== 'fulmine-script-migration-required') ||
                          contract.expired ||
                          escrowValue === 0 ||
                          recoverableValue > 0 ||
                          contract.signingInProgress
                        }
                        onClick={() => signAction('migrate', contract)}
                      />
                      <Button
                        label='Recover swept escrow in stock batch'
                        variant='secondary'
                        loading={busy === 'recovery'}
                        disabled={
                          Boolean(busy) ||
                          !mobileControlled ||
                          recoverableValue === 0 ||
                          contract.recovery.state !== 'ready-for-expiry-recovery' ||
                          contract.signingInProgress
                        }
                        onClick={() => startRecovery(contract)}
                      />
                      <Button
                        label={
                          contract.rollover.state === 'available-for-activation-test'
                            ? 'Run tiny rollover activation test'
                            : contract.rollover.state === 'not-due'
                              ? 'Rollover early'
                              : 'Rollover in stock batch'
                        }
                        variant='secondary'
                        loading={busy === 'rollover'}
                        disabled={
                          Boolean(busy) ||
                          !mobileControlled ||
                          !canRollover ||
                          escrowValue === 0 ||
                          recoverableValue > 0 ||
                          contract.signingInProgress
                        }
                        onClick={() => startRollover(contract)}
                      />
                      {contract.rolloverRequired ? (
                        <Button
                          label={
                            contract.automaticRollover.state === 'ready-for-mutual-preauthorization'
                              ? 'Preauthorize one automatic rollover'
                              : contract.automaticRollover.state === 'already-preauthorized'
                                ? 'Automatic rollover already preauthorized'
                                : 'Automatic rollover unavailable'
                          }
                          variant='secondary'
                          loading={busy === 'rollover'}
                          disabled={
                            Boolean(busy) ||
                            contract.automaticRollover.state !== 'ready-for-mutual-preauthorization' ||
                            escrowValue === 0 ||
                            recoverableValue > 0 ||
                            contract.signingInProgress
                          }
                          onClick={() => preauthorizeRollover(contract)}
                        />
                      ) : null}
                      {contract.rolloverRequired && contract.automaticRollover.state === 'already-preauthorized' ? (
                        <Button
                          label='Run automatic rollover activation test now'
                          variant='secondary'
                          loading={busy === 'rollover'}
                          disabled={Boolean(busy) || escrowValue === 0 || recoverableValue > 0 || contract.signingInProgress}
                          onClick={async () => {
                            setBusy('rollover')
                            setError('')
                            try {
                              const plan = await requestJson<EscrowStatus['automaticRollover']>(
                                '/owner/api/warden/rollover/activation-plan',
                                { method: 'POST', body: JSON.stringify({ contractId: contract.contractId }) },
                              )
                              const candidate = { ...contract, automaticRollover: plan }
                              setBusy('')
                              await preauthorizeRollover(candidate, true)
                            } catch (err) {
                              setError(err instanceof Error ? err.message : 'Unable to prepare activation test')
                              setBusy('')
                            }
                          }}
                        />
                      ) : null}
                    </FlexCol>
                  </div>
                )
              })}
              {visibleContracts.length === 0 ? <TextSecondary>No active or funded contracts.</TextSecondary> : null}
              <TextSecondary>
                {archivedEmpty} empty historical contract{archivedEmpty === 1 ? '' : 's'} scanned. Funded or recoverable
                contracts never disappear from this list. Long-term automatic rollover remains disabled until the funded
                manual-rollover and expiry-recovery gates are both proven.
              </TextSecondary>
            </FlexCol>
          </FlexCol>
        </Padded>
      </Content>
    </>
  )
}
