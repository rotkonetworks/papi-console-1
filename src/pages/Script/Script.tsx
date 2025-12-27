import { CodeEditor, CodeError, Suggestion as EditorSuggestion } from "@/components/CodeEditor"
import { ActionButton } from "@/components/ActionButton"
import { LoadingMetadata } from "@/components/Loading"
import { withSubscribe } from "@/components/withSuspense"
import { unsafeApi$, metadata$ } from "@/state/chains/chain.state"
import { script$, setScript } from "@/state/script.state"
import { Binary } from "polkadot-api"
import { getPolkadotSigner } from "@polkadot-api/signer"
import { FC, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { firstValueFrom } from "rxjs"
import { useStateObservable } from "@react-rxjs/core"
import { Play, Copy, Check, Square, Command, Trash2, Undo2, Redo2, Share2 } from "lucide-react"
import { Spinner } from "@/components/Icons"
import { sr25519CreateDerive } from "@polkadot-labs/hdkd"
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
  sr25519,
} from "@polkadot-labs/hdkd-helpers"
import { AccountPicker } from "@polkahub/ui-components"
import { AddressIdentity, useAvailableAccounts, useSelectedAccount } from "polkahub"
import { cn } from "@/lib/utils"
import { UnifiedMetadata, V14Lookup } from "@polkadot-api/substrate-bindings"

const groupLabels: Record<string, string> = {
  ledger: "Ledger",
  readonly: "Read Only",
  "polkadot-vault": "Vault",
  walletconnect: "Wallet Connect",
}

const DEFAULT_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk"

const createSigner = (mnemonic: string = `${DEFAULT_MNEMONIC}//Alice`) => {
  // support derivation paths like "word word word//Alice"
  const parts = mnemonic.split("//")
  const words = parts[0].trim()
  const derivation = parts.length > 1 ? `//${parts.slice(1).join("//")}` : ""

  const entropy = mnemonicToEntropy(words)
  const miniSecret = entropyToMiniSecret(entropy)
  const derive = sr25519CreateDerive(miniSecret)
  const hdkdKeyPair = derive(derivation)
  return getPolkadotSigner(
    hdkdKeyPair.publicKey,
    "Sr25519",
    hdkdKeyPair.sign,
  )
}

const fromSecretKey = (hex: string) => {
  const secretKey = hex.startsWith("0x") ? hex.slice(2) : hex
  const publicKey = sr25519.getPublicKey(secretKey)
  return getPolkadotSigner(
    publicKey,
    "Sr25519",
    (msg) => sr25519.sign(msg, secretKey),
  )
}

const EMPTY_SCRIPT = `const signer = createSigner()  // Alice

// watch for transfers and react with a remark
const sub = api.event.Balances.Transfer.watch().subscribe(async (event) => {
  const { from, to, amount } = event.payload
  console.log(\`saw transfer: \${amount} from \${from}\`)

  // react by submitting a remark
  const tx = api.tx.System.remark({
    remark: Binary.fromText(\`saw transfer of \${amount}\`)
  })
  const result = await tx.signAndSubmit(signer)
  console.log("remark submitted in block:", result.block.number)

  sub.unsubscribe()
})

// wait for a transfer (stop button to cancel)
await sleep(60000)
sub.unsubscribe()
`

type Suggestion = {
  kind: "tx" | "query" | "const" | "event" | "error" | "api"
  pallet: string
  name: string
  args: number
  isMap: boolean
  docs: string
  fields?: { name: string; type: string }[]
}

const buildSuggestions = (metadata: UnifiedMetadata): Suggestion[] => {
  const suggestions: Suggestion[] = []
  const lookup = metadata.lookup as V14Lookup

  const getTypeName = (typeId: number): string => {
    const t = lookup[typeId]
    if (!t) return "unknown"
    if (t.def.tag === "primitive") return t.def.value.tag
    if (t.def.tag === "compact") return `Compact<${getTypeName(t.def.value)}>`
    if (t.def.tag === "sequence") return `Vec<${getTypeName(t.def.value)}>`
    if (t.def.tag === "array") return `[${getTypeName(t.def.value.type)}; ${t.def.value.len}]`
    if (t.def.tag === "tuple") return `(${t.def.value.map(getTypeName).join(", ")})`
    if (t.path.length > 0) return t.path[t.path.length - 1]
    return "unknown"
  }

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
        docs: variant.docs.join(" ").slice(0, 200),
        fields: variant.fields.map(f => ({
          name: f.name ?? "value",
          type: getTypeName(f.type),
        })),
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
        docs: entry.docs.join(" ").slice(0, 200),
      })
    }
  }

  // add constants
  for (const pallet of metadata.pallets) {
    for (const constant of pallet.constants) {
      suggestions.push({
        kind: "const",
        pallet: pallet.name,
        name: constant.name,
        args: 0,
        isMap: false,
        docs: constant.docs.join(" ").slice(0, 200),
      })
    }
  }

  // add events
  for (const pallet of metadata.pallets) {
    if (!pallet.events) continue

    const eventType = lookup[pallet.events.type]
    if (!eventType || eventType.def.tag !== "variant") continue

    for (const variant of eventType.def.value) {
      suggestions.push({
        kind: "event",
        pallet: pallet.name,
        name: variant.name,
        args: variant.fields.length,
        isMap: false,
        docs: variant.docs.join(" ").slice(0, 200),
        fields: variant.fields.map(f => ({
          name: f.name ?? "value",
          type: getTypeName(f.type),
        })),
      })
    }
  }

  // add errors
  for (const pallet of metadata.pallets) {
    if (!pallet.errors) continue

    const errorType = lookup[pallet.errors.type]
    if (!errorType || errorType.def.tag !== "variant") continue

    for (const variant of errorType.def.value) {
      suggestions.push({
        kind: "error",
        pallet: pallet.name,
        name: variant.name,
        args: variant.fields.length,
        isMap: false,
        docs: variant.docs.join(" ").slice(0, 200),
        fields: variant.fields.map(f => ({
          name: f.name ?? "value",
          type: getTypeName(f.type),
        })),
      })
    }
  }

  // add runtime apis
  for (const api of metadata.apis) {
    for (const method of api.methods) {
      suggestions.push({
        kind: "api",
        pallet: api.name,
        name: method.name,
        args: method.inputs.length,
        isMap: false,
        docs: method.docs.join(" ").slice(0, 200),
        fields: method.inputs.map(i => ({
          name: i.name,
          type: getTypeName(i.type),
        })),
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
    const fields = s.fields?.map(f => `  ${f.name}: ,  // ${f.type}`).join("\n") ?? ""
    return `api.tx.${s.pallet}.${s.name}({\n${fields}\n})`
  } else if (s.kind === "query") {
    if (s.args === 0) {
      return `await api.query.${s.pallet}.${s.name}.getValue()`
    }
    if (s.args === 1) {
      return `await api.query.${s.pallet}.${s.name}.getValue(key)`
    }
    return `await api.query.${s.pallet}.${s.name}.getValue(/* ${s.args} keys */)`
  } else if (s.kind === "event") {
    return `api.event.${s.pallet}.${s.name}`
  } else if (s.kind === "error") {
    return `api.errors.${s.pallet}.${s.name}`
  } else if (s.kind === "api") {
    if (s.args === 0) {
      return `await api.apis.${s.pallet}.${s.name}()`
    }
    const args = s.fields?.map(f => f.name).join(", ") ?? ""
    return `await api.apis.${s.pallet}.${s.name}(${args})`
  } else {
    return `api.constants.${s.pallet}.${s.name}`
  }
}

// simple compression for URL sharing using base64
const encodeScript = (code: string): string => {
  try {
    return btoa(encodeURIComponent(code))
  } catch {
    return ""
  }
}

const decodeScript = (encoded: string): string | null => {
  try {
    return decodeURIComponent(atob(encoded))
  } catch {
    return null
  }
}

const ScriptEditor: FC<{ metadata: UnifiedMetadata }> = ({ metadata }) => {
  const script = useStateObservable(script$)
  const initializedRef = useRef(false)
  const [output, setOutput] = useState<string[]>([])
  const [errors, setErrors] = useState<CodeError[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [paletteFilter, setPaletteFilter] = useState("")
  const [paletteIndex, setPaletteIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const undoRedoRef = useRef<{ undo: () => void; redo: () => void; canUndo: () => boolean; canRedo: () => boolean } | null>(null)
  const [, forceUpdate] = useState(0)

  const availableAccounts = useAvailableAccounts()
  const [account, setAccount] = useSelectedAccount()

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

  // suggestions for inline editor autocomplete
  const editorSuggestions: EditorSuggestion[] = useMemo(() =>
    allSuggestions.map(s => ({
      label: `${s.pallet}.${s.name}`,
      insert: s.kind === "tx"
        ? `${s.pallet}.${s.name}(${s.args > 0 ? "{ }" : ""})`
        : s.kind === "query"
          ? `${s.pallet}.${s.name}.getValue(${s.args > 0 ? "key" : ""})`
          : s.kind === "api"
            ? `${s.pallet}.${s.name}(${s.args > 0 ? s.fields?.map(f => f.name).join(", ") : ""})`
            : `${s.pallet}.${s.name}`,
      kind: s.kind,
      docs: s.docs,
      fields: s.fields,
    })),
    [allSuggestions]
  )

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      // check URL for shared script
      const params = new URLSearchParams(window.location.search)
      const encodedScript = params.get("code")
      if (encodedScript) {
        const decoded = decodeScript(encodedScript)
        if (decoded) {
          setScript(decoded)
          // clean URL
          window.history.replaceState({}, "", window.location.pathname)
          return
        }
      }
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
    setIsRunning(true)
    setOutput([])
    setErrors([])
    abortRef.current = new AbortController()

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor

    try {
      try {
        new AsyncFunction(script)
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

      const fn = new AsyncFunction(
        "api", "console", "Binary", "createSigner", "fromSecretKey", "sleep", "walletSigner",
        script
      )

      await fn(
        unsafeApi,
        mockConsole,
        Binary,
        createSigner,
        fromSecretKey,
        sleep,
        account?.signer ?? null
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

  const shareScript = async () => {
    const encoded = encodeScript(script)
    if (!encoded) return
    const url = `${window.location.origin}${window.location.pathname}?code=${encoded}`
    await navigator.clipboard.writeText(url)
    setShared(true)
    setTimeout(() => setShared(false), 2000)
  }

  return (
    <div className="flex flex-col gap-2 overflow-hidden flex-1">
      <div className="flex gap-2 items-center flex-wrap">
        {!isRunning ? (
          <ActionButton
            onClick={runScript}
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

        <ActionButton
          onClick={() => {
            undoRedoRef.current?.undo()
            forceUpdate(n => n + 1)
          }}
          className="flex items-center gap-1 text-foreground/70"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={16} />
        </ActionButton>

        <ActionButton
          onClick={() => {
            undoRedoRef.current?.redo()
            forceUpdate(n => n + 1)
          }}
          className="flex items-center gap-1 text-foreground/70"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={16} />
        </ActionButton>

        <ActionButton onClick={copyScript} className="flex items-center gap-1" title="Copy script">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </ActionButton>

        <ActionButton onClick={shareScript} className="flex items-center gap-1" title="Copy shareable URL">
          {shared ? <Check size={16} /> : <Share2 size={16} />}
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

        <div className="flex items-center gap-1 ml-2 border-l pl-2 border-foreground/20">
          <span className="text-xs text-foreground/50">signer:</span>
          <select
            className="px-2 py-1 border rounded bg-background text-foreground text-xs"
            defaultValue=""
            onChange={(e) => {
              if (!e.target.value) return
              let code = ""
              if (e.target.value === "mnemonic") {
                code = `const signer = createSigner("word1 word2 ... word12")\n`
              } else if (e.target.value === "secretkey") {
                code = `const signer = fromSecretKey("0x...")\n`
              } else if (e.target.value === "wallet") {
                code = `const signer = walletSigner  // from wallet picker\n`
              } else {
                code = `const signer = createSigner("${DEFAULT_MNEMONIC}//${e.target.value}")\n`
              }
              setScript(code + script)
              e.target.value = ""
            }}
          >
            <option value="">insert...</option>
            <optgroup label="Wallet">
              <option value="wallet">Use wallet signer</option>
            </optgroup>
            <optgroup label="Dev Accounts">
              {["Alice", "Bob", "Charlie", "Dave", "Eve", "Ferdie"].map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </optgroup>
            <optgroup label="Custom">
              <option value="mnemonic">From mnemonic</option>
              <option value="secretkey">From secret key</option>
            </optgroup>
          </select>
          <div className="min-w-[140px]">
            {groups.length > 0 ? (
              <AccountPicker
                value={account}
                onChange={setAccount}
                groups={groups}
                className={cn("w-full text-xs")}
                renderAddress={(account) => (
                  <AddressIdentity
                    addr={account.address}
                    name={account?.name}
                    copyable={false}
                  />
                )}
              />
            ) : (
              <span className="text-xs text-foreground/40">no wallets</span>
            )}
          </div>
        </div>

        {isRunning && <Spinner size={16} />}
      </div>

      <CodeEditor
        value={script}
        onChange={(v) => {
          setScript(v)
          setErrors([])
        }}
        errors={errors}
        suggestions={editorSuggestions}
        onRun={runScript}
        undoRedoRef={undoRedoRef}
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
    const metadata = useStateObservable(metadata$)

    return (
      <div className="flex flex-col overflow-hidden gap-2 p-4 absolute w-full h-full max-w-(--breakpoint-xl)">
        <h1 className="text-xl font-medium">Script Editor</h1>
        <p className="text-foreground/60 text-sm">
          Write and execute papi scripts. Ctrl+Space for palette, Ctrl+Enter to run.
        </p>
        <ScriptEditor metadata={metadata} />
      </div>
    )
  },
  {
    fallback: <LoadingMetadata />,
  },
)
