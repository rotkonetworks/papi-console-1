import { CodeEditor, CodeError } from "@/components/CodeEditor"
import { ActionButton } from "@/components/ActionButton"
import { LoadingMetadata } from "@/components/Loading"
import { withSubscribe } from "@/components/withSuspense"
import { unsafeApi$, runtimeCtx$ } from "@/state/chains/chain.state"
import { script$, setScript } from "@/state/script.state"
import { Binary } from "polkadot-api"
import { getPolkadotSigner } from "@polkadot-api/signer"
import { FC, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { firstValueFrom } from "rxjs"
import { useStateObservable } from "@react-rxjs/core"
import { Play, Copy, Check, Square, Command, Trash2 } from "lucide-react"
import { Spinner } from "@/components/Icons"
import { sr25519CreateDerive } from "@polkadot-labs/hdkd"
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers"
import { AccountPicker } from "@polkahub/ui-components"
import { AddressIdentity, useAvailableAccounts, useSelectedAccount } from "polkahub"
import { cn } from "@/lib/utils"
import { UnifiedMetadata, V14Lookup } from "@polkadot-api/substrate-bindings"

const createSigner = (mnemonic: string, derivation = "") => {
  const entropy = mnemonicToEntropy(mnemonic)
  const miniSecret = entropyToMiniSecret(entropy)
  const derive = sr25519CreateDerive(miniSecret)
  const hdkdKeyPair = derive(derivation)
  return getPolkadotSigner(
    hdkdKeyPair.publicKey,
    "Sr25519",
    hdkdKeyPair.sign,
  )
}

const getDevSigner = (name: string) => {
  return createSigner(DEV_PHRASE, `//${name}`)
}

const EMPTY_SCRIPT = `// signer = selected account (or use getDevSigner("Alice") for dev chains)

const tx = api.tx.System.remark({
  remark: Binary.fromText("hello"),
})

await tx.signAndSubmit(signer)
console.log("done")

// loop example:
// for (let i = 0; i < 3; i++) {
//   const tx = api.tx.System.remark({ remark: Binary.fromText(\`msg \${i}\`) })
//   await tx.signAndSubmit(signer)
//   console.log("sent", i)
// }
`

const groupLabels: Record<string, string> = {
  ledger: "Ledger",
  readonly: "Read Only",
  "polkadot-vault": "Vault",
  walletconnect: "Wallet Connect",
}

type Suggestion = {
  kind: "tx" | "query"
  pallet: string
  name: string
  args: number
  isMap: boolean
}

const buildSuggestions = (metadata: UnifiedMetadata): Suggestion[] => {
  const suggestions: Suggestion[] = []
  const lookup = metadata.lookup as V14Lookup

  // add tx calls
  for (const pallet of metadata.pallets) {
    if (!pallet.calls) continue

    const callType = lookup[pallet.calls.type]
    if (!callType || callType.def.tag !== "variant") continue

    for (const variant of callType.def.value) {
      suggestions.push({
        kind: "tx",
        pallet: pallet.name,
        name: variant.name,
        args: variant.fields.length,
        isMap: false,
      })
    }
  }

  // add storage queries
  for (const pallet of metadata.pallets) {
    if (!pallet.storage) continue

    for (const entry of pallet.storage.items) {
      suggestions.push({
        kind: "query",
        pallet: pallet.name,
        name: entry.name,
        args: entry.type.tag === "map" ? entry.type.value.hashers.length : 0,
        isMap: entry.type.tag === "map",
      })
    }
  }

  return suggestions.sort((a, b) =>
    `${a.kind}.${a.pallet}.${a.name}`.localeCompare(`${b.kind}.${b.pallet}.${b.name}`)
  )
}

const generateSnippet = (s: Suggestion): string => {
  if (s.kind === "tx") {
    if (s.args === 0) {
      return `api.tx.${s.pallet}.${s.name}()`
    }
    return `api.tx.${s.pallet}.${s.name}({\n  // ${s.args} args\n})`
  } else {
    if (s.args === 0) {
      return `await api.query.${s.pallet}.${s.name}()`
    }
    if (s.isMap && s.args === 1) {
      return `await api.query.${s.pallet}.${s.name}(key)`
    }
    return `await api.query.${s.pallet}.${s.name}(/* ${s.args} keys */)`
  }
}

const ScriptEditor: FC<{ metadata: UnifiedMetadata }> = ({ metadata }) => {
  const script = useStateObservable(script$)
  const initializedRef = useRef(false)
  const [output, setOutput] = useState<string[]>([])
  const [errors, setErrors] = useState<CodeError[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [paletteFilter, setPaletteFilter] = useState("")
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [signerMode, setSignerMode] = useState<"wallet" | "dev" | "custom">("wallet")
  const [devAccount, setDevAccount] = useState("Alice")
  const [customMnemonic, setCustomMnemonic] = useState("")
  const [customDerivation, setCustomDerivation] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const paletteInputRef = useRef<HTMLInputElement>(null)

  const availableAccounts = useAvailableAccounts()
  const [account, setAccount] = useSelectedAccount()

  const activeSigner = useMemo(() => {
    if (signerMode === "dev") {
      return getDevSigner(devAccount)
    }
    if (signerMode === "custom" && customMnemonic.trim().split(/\s+/).length >= 12) {
      try {
        return createSigner(customMnemonic.trim(), customDerivation || "")
      } catch {
        return null
      }
    }
    return account?.signer ?? null
  }, [signerMode, devAccount, customMnemonic, customDerivation, account])

  const allSuggestions = useMemo(() => buildSuggestions(metadata), [metadata])

  const filteredSuggestions = useMemo(() => {
    if (!paletteFilter) return allSuggestions.slice(0, 50)
    const lower = paletteFilter.toLowerCase()
    return allSuggestions
      .filter(s => {
        const full = `${s.kind}.${s.pallet}.${s.name}`.toLowerCase()
        return full.includes(lower) || `${s.pallet}.${s.name}`.toLowerCase().includes(lower)
      })
      .slice(0, 50)
  }, [allSuggestions, paletteFilter])

  const groups = useMemo(() =>
    Object.entries(availableAccounts)
      .map(([group, accounts]) => [group, accounts.filter((acc) => acc.signer)] as const)
      .filter(([, accounts]) => accounts.length > 0)
      .map(([key, accounts]) => ({
        name: groupLabels[key] ?? key,
        accounts,
      })),
    [availableAccounts]
  )

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      if (!script) {
        setScript(EMPTY_SCRIPT)
      }
    }
  }, [script])

  useEffect(() => {
    if (showPalette) {
      setPaletteFilter("")
      setPaletteIndex(0)
      setTimeout(() => paletteInputRef.current?.focus(), 0)
    }
  }, [showPalette])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === " ") {
        e.preventDefault()
        setShowPalette(true)
      }
      if (e.key === "Escape" && showPalette) {
        setShowPalette(false)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [showPalette])

  const insertSuggestion = useCallback((suggestion: Suggestion) => {
    const snippet = generateSnippet(suggestion)
    const sep = script.trim() ? "\n\n" : ""
    if (suggestion.kind === "tx") {
      setScript(script + sep + "const tx = " + snippet + "\nawait tx.signAndSubmit(signer)")
    } else {
      setScript(script + sep + "const result = " + snippet + "\nconsole.log(result)")
    }
    setShowPalette(false)
  }, [script])

  const stopScript = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
      setIsRunning(false)
      setOutput(prev => [...prev, "--- stopped ---"])
    }
  }

  const parseError = (e: unknown): { message: string; line?: number } => {
    const err = e as Error
    const msg = err.message || String(e)

    const stackMatch = err.stack?.match(/<anonymous>:(\d+):|:(\d+):\d+\)/)
    const lineMatch = msg.match(/line (\d+)/i)

    let line: number | undefined
    if (stackMatch) {
      line = parseInt(stackMatch[1] || stackMatch[2], 10)
    } else if (lineMatch) {
      line = parseInt(lineMatch[1], 10)
    }

    return { message: msg, line }
  }

  const runScript = async () => {
    if (!activeSigner) {
      setOutput(["error: no valid signer configured"])
      return
    }

    setIsRunning(true)
    setOutput([])
    setErrors([])
    abortRef.current = new AbortController()

    try {
      try {
        new Function(script)
      } catch (syntaxErr) {
        const parsed = parseError(syntaxErr)
        if (parsed.line) {
          setErrors([{ line: parsed.line, message: parsed.message }])
        }
        setOutput([`syntax error: ${parsed.message}`])
        setIsRunning(false)
        return
      }

      const unsafeApi = await firstValueFrom(unsafeApi$)

      const logs: string[] = []
      const pushLog = (msg: string) => {
        logs.push(msg)
        setOutput([...logs])
      }

      const mockConsole = {
        log: (...args: unknown[]) => pushLog(args.map(a =>
          typeof a === "object" ? JSON.stringify(a) : String(a)
        ).join(" ")),
        error: (...args: unknown[]) => pushLog(`[error] ${args.join(" ")}`),
        warn: (...args: unknown[]) => pushLog(`[warn] ${args.join(" ")}`),
      }

      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
      const fn = new AsyncFunction(
        "api", "signer", "console", "Binary", "getDevSigner", "createSigner", "sleep",
        script
      )

      await fn(
        unsafeApi,
        activeSigner,
        mockConsole,
        Binary,
        getDevSigner,
        createSigner,
        sleep
      )
      pushLog("--- done ---")
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const parsed = parseError(e)
        if (parsed.line) {
          setErrors([{ line: parsed.line, message: parsed.message }])
        }
        setOutput(prev => [...prev, `error: ${parsed.message}`])
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }

  const copyScript = async () => {
    await navigator.clipboard.writeText(script)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col gap-2 overflow-hidden flex-1">
      <div className="flex gap-2 items-center flex-wrap">
        {!isRunning ? (
          <ActionButton
            onClick={runScript}
            disabled={!activeSigner}
            className="flex items-center gap-2"
          >
            <Play size={16} />
            run
          </ActionButton>
        ) : (
          <ActionButton
            onClick={stopScript}
            className="flex items-center gap-2 text-red-500"
          >
            <Square size={16} />
            stop
          </ActionButton>
        )}

        <ActionButton onClick={copyScript} className="flex items-center gap-1">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </ActionButton>

        <ActionButton
          onClick={() => setShowPalette(true)}
          className="flex items-center gap-1 text-foreground/70"
          title="Insert call (Ctrl+Space)"
        >
          <Command size={16} />
        </ActionButton>

        <ActionButton
          onClick={() => setScript("")}
          className="flex items-center gap-1 text-foreground/50"
          title="Clear script"
        >
          <Trash2 size={16} />
        </ActionButton>

        <select
          value={signerMode}
          onChange={e => setSignerMode(e.target.value as "wallet" | "dev" | "custom")}
          className="px-2 py-1 border rounded bg-background text-foreground text-sm"
        >
          <option value="wallet">Wallet</option>
          <option value="dev">Dev Account</option>
          <option value="custom">Mnemonic</option>
        </select>

        {signerMode === "wallet" && (
          <div className="min-w-[180px] max-w-[280px]">
            <AccountPicker
              value={account}
              onChange={setAccount}
              groups={groups}
              className={cn("w-full")}
              renderAddress={(account) => (
                <AddressIdentity
                  addr={account.address}
                  name={account?.name}
                  copyable={false}
                />
              )}
            />
          </div>
        )}

        {signerMode === "dev" && (
          <select
            value={devAccount}
            onChange={e => setDevAccount(e.target.value)}
            className="px-2 py-1 border rounded bg-background text-foreground text-sm"
          >
            {["Alice", "Bob", "Charlie", "Dave", "Eve", "Ferdie"].map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}

        {signerMode === "custom" && (
          <div className="flex gap-1 items-center">
            <input
              type="password"
              placeholder="12-word mnemonic..."
              value={customMnemonic}
              onChange={e => setCustomMnemonic(e.target.value)}
              className="px-2 py-1 border rounded bg-background text-foreground text-sm w-[200px]"
            />
            <input
              type="text"
              placeholder="//path"
              value={customDerivation}
              onChange={e => setCustomDerivation(e.target.value)}
              className="px-2 py-1 border rounded bg-background text-foreground text-sm w-[80px]"
            />
          </div>
        )}

        {isRunning && <Spinner size={16} />}
      </div>

      <CodeEditor
        value={script}
        onChange={(v) => {
          setScript(v)
          setErrors([])
        }}
        errors={errors}
        className="flex-1 min-h-[300px] overflow-auto border rounded"
      />

      {output.length > 0 && (
        <div className="bg-background border rounded p-3 font-mono text-sm max-h-48 overflow-auto shrink-0">
          {output.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("[error]") || line.startsWith("error")
                  ? "text-red-500"
                  : line.startsWith("[warn]")
                    ? "text-yellow-500"
                    : line.startsWith("---")
                      ? "text-foreground/50"
                      : ""
              }
            >
              {line}
            </div>
          ))}
        </div>
      )}

      {showPalette && (
        <div
          className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
          onClick={() => setShowPalette(false)}
        >
          <div
            className="bg-background border rounded-lg shadow-xl w-full max-w-lg max-h-[60vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-3 border-b">
              <input
                ref={paletteInputRef}
                type="text"
                placeholder="Search calls... (e.g. Balances.transfer)"
                className="w-full px-3 py-2 bg-transparent border rounded text-foreground outline-none focus:border-polkadot-400"
                value={paletteFilter}
                onChange={e => {
                  setPaletteFilter(e.target.value)
                  setPaletteIndex(0)
                }}
                onKeyDown={e => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault()
                    setPaletteIndex(i => Math.min(i + 1, filteredSuggestions.length - 1))
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault()
                    setPaletteIndex(i => Math.max(i - 1, 0))
                  } else if (e.key === "Enter" && filteredSuggestions[paletteIndex]) {
                    e.preventDefault()
                    insertSuggestion(filteredSuggestions[paletteIndex])
                  }
                }}
              />
            </div>
            <div className="overflow-auto flex-1">
              {filteredSuggestions.map((s, i) => (
                <div
                  key={`${s.kind}.${s.pallet}.${s.name}`}
                  className={cn(
                    "px-3 py-2 cursor-pointer hover:bg-foreground/10 flex justify-between items-center",
                    i === paletteIndex && "bg-foreground/10"
                  )}
                  onClick={() => insertSuggestion(s)}
                  onMouseEnter={() => setPaletteIndex(i)}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded font-medium",
                      s.kind === "tx" ? "bg-pink-500/20 text-pink-400" : "bg-blue-500/20 text-blue-400"
                    )}>
                      {s.kind}
                    </span>
                    <span>
                      <span className="text-polkadot-400">{s.pallet}</span>
                      <span className="text-foreground/50">.</span>
                      <span>{s.name}</span>
                    </span>
                  </div>
                  <span className="text-foreground/30 text-xs">
                    {s.args > 0 ? `${s.args} ${s.kind === "query" ? "keys" : "args"}` : ""}
                  </span>
                </div>
              ))}
              {filteredSuggestions.length === 0 && (
                <div className="px-3 py-4 text-foreground/50 text-center">
                  No matches
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const Script = withSubscribe(
  () => {
    const { metadata } = useStateObservable(runtimeCtx$)

    return (
      <div className="flex flex-col overflow-hidden gap-2 p-4 absolute w-full h-full max-w-(--breakpoint-xl)">
        <h1 className="text-xl font-medium">Script Editor</h1>
        <p className="text-foreground/60 text-sm">
          Write and execute papi scripts. Use Ctrl+Space for autocomplete.
        </p>
        <ScriptEditor metadata={metadata} />
      </div>
    )
  },
  {
    fallback: <LoadingMetadata />,
  },
)
