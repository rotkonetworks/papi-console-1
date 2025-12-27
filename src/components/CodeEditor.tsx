import { useTheme } from "@/ThemeProvider"
import { CodeJar } from "codejar"
import Prism from "prismjs"
import "prismjs/components/prism-typescript"
import "prismjs/themes/prism-tomorrow.css"
import { FC, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export type Suggestion = {
  label: string
  insert: string
  kind: "tx" | "query" | "const" | "event" | "error" | "api"
  docs?: string
  fields?: { name: string; type: string }[]
}

const highlight = (editor: HTMLElement) => {
  const code = editor.textContent ?? ""
  editor.innerHTML = Prism.highlight(code, Prism.languages.typescript, "typescript")
}

export type CodeError = {
  line: number
  message: string
}

const MAX_HISTORY = 100
const DEBOUNCE_MS = 300

// Binary helper methods for autocomplete
const BINARY_METHODS: Suggestion[] = [
  { label: "fromText", insert: "fromText(\"\")", kind: "api", docs: "Create Binary from UTF-8 text string" },
  { label: "fromHex", insert: "fromHex(\"0x\")", kind: "api", docs: "Create Binary from hex string" },
  { label: "fromBytes", insert: "fromBytes(new Uint8Array([]))", kind: "api", docs: "Create Binary from Uint8Array" },
]

export const CodeEditor: FC<{
  value: string
  onChange: (value: string) => void
  className?: string
  readOnly?: boolean
  errors?: CodeError[]
  suggestions?: Suggestion[]
  onRun?: () => void
  undoRedoRef?: React.MutableRefObject<{ undo: () => void; redo: () => void; canUndo: () => boolean; canRedo: () => boolean } | null>
}> = ({ value, onChange, className, readOnly, errors = [], suggestions = [], onRun, undoRedoRef }) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const jarRef = useRef<ReturnType<typeof CodeJar> | null>(null)
  const theme = useTheme()

  // autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteItems, setAutocompleteItems] = useState<Suggestion[]>([])
  const [autocompleteIndex, setAutocompleteIndex] = useState(0)
  const [autocompletePos, setAutocompletePos] = useState({ top: 0, left: 0 })
  const [autocompletePrefix, setAutocompletePrefix] = useState("")
  const autocompleteRef = useRef<HTMLDivElement>(null)

  // refs to avoid rerunning CodeJar effect when autocomplete state changes
  const autocompleteStateRef = useRef({
    show: false,
    items: [] as Suggestion[],
    index: 0,
  })
  autocompleteStateRef.current = {
    show: showAutocomplete,
    items: autocompleteItems,
    index: autocompleteIndex,
  }

  // hover tooltip state
  const [hoverItem, setHoverItem] = useState<Suggestion | null>(null)

  // undo/redo history
  const historyRef = useRef<string[]>([value])
  const historyIndexRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUndoRedoRef = useRef(false)
  const isNavigatingRef = useRef(false)
  const insertSuggestionRef = useRef<(s: Suggestion) => void>(() => {})
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun

  const lines = value.split("\n")
  const errorsByLine = new Map(errors.map(e => [e.line, e.message]))

  const pushHistory = useCallback((newValue: string) => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false
      return
    }

    // debounce history pushes
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      const history = historyRef.current
      const index = historyIndexRef.current

      // if we're not at the end, truncate forward history
      if (index < history.length - 1) {
        historyRef.current = history.slice(0, index + 1)
      }

      // don't push if same as last
      if (historyRef.current[historyRef.current.length - 1] !== newValue) {
        historyRef.current.push(newValue)
        if (historyRef.current.length > MAX_HISTORY) {
          historyRef.current.shift()
        }
        historyIndexRef.current = historyRef.current.length - 1
      }
    }, DEBOUNCE_MS)
  }, [])

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--
      const newValue = historyRef.current[historyIndexRef.current]
      isUndoRedoRef.current = true
      onChange(newValue)
      if (jarRef.current) {
        jarRef.current.updateCode(newValue)
      }
    }
  }, [onChange])

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++
      const newValue = historyRef.current[historyIndexRef.current]
      isUndoRedoRef.current = true
      onChange(newValue)
      if (jarRef.current) {
        jarRef.current.updateCode(newValue)
      }
    }
  }, [onChange])

  const canUndo = useCallback(() => historyIndexRef.current > 0, [])
  const canRedo = useCallback(() => historyIndexRef.current < historyRef.current.length - 1, [])

  // expose undo/redo via ref
  useEffect(() => {
    if (undoRedoRef) {
      undoRedoRef.current = { undo, redo, canUndo, canRedo }
    }
  }, [undoRedoRef, undo, redo, canUndo, canRedo])

  // get cursor position in pixels
  const getCursorPosition = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const editorRect = editorRef.current?.getBoundingClientRect()
    if (!editorRect) return null
    return {
      top: rect.bottom - editorRect.top,
      left: rect.left - editorRect.left,
    }
  }, [])

  // insert autocomplete suggestion
  const insertSuggestion = useCallback((suggestion: Suggestion) => {
    if (!editorRef.current) return
    const text = editorRef.current.textContent ?? ""
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    // find cursor position in text
    const range = sel.getRangeAt(0)
    let cursorPos = 0
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode === range.startContainer) {
        cursorPos += range.startOffset
        break
      }
      cursorPos += (walker.currentNode.textContent?.length ?? 0)
    }

    // find start of the trigger
    const beforeCursor = text.slice(0, cursorPos)

    // check for Binary. completion
    const binaryMatch = beforeCursor.match(/Binary\.(\w*)$/)
    if (binaryMatch) {
      const prefixStart = cursorPos - binaryMatch[1].length
      const newText = text.slice(0, prefixStart) + suggestion.insert + text.slice(cursorPos)
      onChange(newText)
      pushHistory(newText)
      if (jarRef.current) {
        jarRef.current.updateCode(newText)
      }
      setShowAutocomplete(false)
      return
    }

    // check for namespace completion (api.tx, api.query, etc)
    const apiMatch = beforeCursor.match(/api\.(\w*)$/)
    if (apiMatch && !beforeCursor.match(/api\.(tx|query|constants|event|errors|apis)\./)) {
      const prefixStart = cursorPos - apiMatch[1].length
      const newText = text.slice(0, prefixStart) + suggestion.insert + text.slice(cursorPos)
      onChange(newText)
      pushHistory(newText)
      if (jarRef.current) {
        jarRef.current.updateCode(newText)
      }
      setShowAutocomplete(false)
      return
    }

    const txMatch = beforeCursor.match(/api\.tx\.(\w*)$/)
    const queryMatch = beforeCursor.match(/api\.query\.(\w*)$/)
    const constMatch = beforeCursor.match(/api\.constants\.(\w*)$/)
    const eventMatch = beforeCursor.match(/api\.event\.(\w*)$/)
    const errorMatch = beforeCursor.match(/api\.errors\.(\w*)$/)
    const apisMatch = beforeCursor.match(/api\.apis\.(\w*)$/)
    const match = txMatch || queryMatch || constMatch || eventMatch || errorMatch || apisMatch

    if (!match) {
      setShowAutocomplete(false)
      return
    }

    const prefixStart = cursorPos - match[1].length
    const newText = text.slice(0, prefixStart) + suggestion.insert + text.slice(cursorPos)

    onChange(newText)
    pushHistory(newText)
    if (jarRef.current) {
      jarRef.current.updateCode(newText)
    }
    setShowAutocomplete(false)

    // restore cursor after the inserted text
    setTimeout(() => {
      if (!editorRef.current) return
      const newCursorPos = prefixStart + suggestion.insert.length
      const sel = window.getSelection()
      if (!sel) return

      let pos = 0
      const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const nodeLen = walker.currentNode.textContent?.length ?? 0
        if (pos + nodeLen >= newCursorPos) {
          const range = document.createRange()
          range.setStart(walker.currentNode, newCursorPos - pos)
          range.collapse(true)
          sel.removeAllRanges()
          sel.addRange(range)
          break
        }
        pos += nodeLen
      }
    }, 0)
  }, [onChange, pushHistory])

  // keep ref in sync
  insertSuggestionRef.current = insertSuggestion

  // check for autocomplete triggers on input
  const checkAutocomplete = useCallback(() => {
    if (isNavigatingRef.current) {
      isNavigatingRef.current = false
      return
    }
    if (!editorRef.current || suggestions.length === 0) return

    const text = editorRef.current.textContent ?? ""
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    // find cursor position
    const range = sel.getRangeAt(0)
    let cursorPos = 0
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode === range.startContainer) {
        cursorPos += range.startOffset
        break
      }
      cursorPos += (walker.currentNode.textContent?.length ?? 0)
    }

    const beforeCursor = text.slice(0, cursorPos)

    // check for "Binary." to show helper methods
    const binaryMatch = beforeCursor.match(/Binary\.(\w*)$/)
    if (binaryMatch) {
      const prefix = binaryMatch[1].toLowerCase()
      const filtered = BINARY_METHODS.filter(m => m.label.toLowerCase().includes(prefix))
      if (filtered.length > 0) {
        const pos = getCursorPosition()
        if (pos) {
          setAutocompletePos(pos)
          setAutocompleteItems(filtered)
          setAutocompleteIndex(0)
          setAutocompletePrefix(prefix)
          setShowAutocomplete(true)
        }
        return
      }
    }

    // check for "api." to show namespace options
    const apiMatch = beforeCursor.match(/api\.(\w*)$/)
    if (apiMatch && !beforeCursor.match(/api\.(tx|query|constants|event|errors|apis)\./)) {
      const prefix = apiMatch[1].toLowerCase()
      const namespaces = [
        { label: "tx", insert: "tx.", kind: "tx" as const, docs: "Submit transactions" },
        { label: "query", insert: "query.", kind: "query" as const, docs: "Read storage" },
        { label: "constants", insert: "constants.", kind: "const" as const, docs: "Runtime constants" },
        { label: "event", insert: "event.", kind: "event" as const, docs: "Chain events" },
        { label: "errors", insert: "errors.", kind: "error" as const, docs: "Error types for matching" },
        { label: "apis", insert: "apis.", kind: "api" as const, docs: "Runtime API calls" },
      ].filter(n => n.label.includes(prefix))

      if (namespaces.length > 0) {
        const pos = getCursorPosition()
        if (pos) {
          setAutocompletePos(pos)
          setAutocompleteItems(prev => {
            const same = prev.length === namespaces.length && prev.every((p, i) => p.label === namespaces[i].label)
            if (!same) setAutocompleteIndex(0)
            return namespaces
          })
          setAutocompletePrefix(prefix)
          setShowAutocomplete(true)
        }
        return
      }
    }

    const txMatch = beforeCursor.match(/api\.tx\.(\w*)$/)
    const queryMatch = beforeCursor.match(/api\.query\.(\w*)$/)
    const constMatch = beforeCursor.match(/api\.constants\.(\w*)$/)
    const eventMatch = beforeCursor.match(/api\.event\.(\w*)$/)
    const errorMatch = beforeCursor.match(/api\.errors\.(\w*)$/)
    const apisMatch = beforeCursor.match(/api\.apis\.(\w*)$/)

    const match = txMatch || queryMatch || constMatch || eventMatch || errorMatch || apisMatch
    const kind = txMatch ? "tx" : queryMatch ? "query" : constMatch ? "const" : eventMatch ? "event" : errorMatch ? "error" : apisMatch ? "api" : null

    if (match && kind) {
      const prefix = match[1].toLowerCase()
      const filtered = suggestions
        .filter(s => s.kind === kind && s.label.toLowerCase().includes(prefix))
        .slice(0, 50)
      if (filtered.length > 0) {
        const pos = getCursorPosition()
        if (pos) {
          setAutocompletePos(pos)
          setAutocompleteItems(prev => {
            const same = prev.length === filtered.length && prev.every((p, i) => p.label === filtered[i].label)
            if (!same) setAutocompleteIndex(0)
            return filtered
          })
          setAutocompletePrefix(prefix)
          setShowAutocomplete(true)
        }
      } else {
        setShowAutocomplete(false)
      }
    } else {
      setShowAutocomplete(false)
    }
  }, [suggestions, getCursorPosition])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // undo/redo handled at window level
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        if (e.shiftKey) {
          e.preventDefault()
          redo()
        } else {
          e.preventDefault()
          undo()
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [undo, redo])

  // CodeJar initialization - only runs once
  useEffect(() => {
    if (!editorRef.current) return
    const el = editorRef.current

    // add keyboard handler BEFORE CodeJar so we can intercept events
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Enter to run script
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        onRunRef.current?.()
        return
      }

      const { show, items, index } = autocompleteStateRef.current
      if (show && items.length > 0) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          isNavigatingRef.current = true
          if (e.key === "ArrowDown") {
            setAutocompleteIndex(i => Math.min(i + 1, items.length - 1))
          } else {
            setAutocompleteIndex(i => Math.max(i - 1, 0))
          }
          return
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          if (items[index]) {
            insertSuggestionRef.current(items[index])
          }
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          setShowAutocomplete(false)
          return
        }
      }
    }
    el.addEventListener("keydown", handleKeyDown)

    const jar = CodeJar(el, highlight, {
      tab: "  ",
      indentOn: /[{[(]$/,
      addClosing: true,
    })

    jar.updateCode(value)
    jar.onUpdate((newValue) => {
      onChange(newValue)
      pushHistory(newValue)
      // check autocomplete after a short delay
      setTimeout(checkAutocomplete, 10)
    })
    jarRef.current = jar

    return () => {
      el.removeEventListener("keydown", handleKeyDown)
      jar.destroy()
      jarRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (jarRef.current && jarRef.current.toString() !== value) {
      jarRef.current.updateCode(value)
    }
  }, [value])

  // scroll selected autocomplete item into view
  useEffect(() => {
    if (showAutocomplete && autocompleteRef.current) {
      const selected = autocompleteRef.current.querySelector(`[data-index="${autocompleteIndex}"]`)
      if (selected) {
        selected.scrollIntoView({ block: "nearest" })
      }
    }
  }, [showAutocomplete, autocompleteIndex])

  return (
    <div className={className} style={{ display: "flex", position: "relative" }}>
      <div
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: "14px",
          lineHeight: "1.5",
          padding: "16px 8px",
          textAlign: "right",
          userSelect: "none",
          color: theme === "dark" ? "#666" : "#999",
          backgroundColor: theme === "dark" ? "#1a1a1a" : "#eee",
          borderRadius: "8px 0 0 8px",
          minWidth: "3em",
        }}
      >
        {lines.map((_, i) => (
          <div
            key={i}
            style={{
              color: errorsByLine.has(i + 1) ? "#f87171" : undefined,
              fontWeight: errorsByLine.has(i + 1) ? "bold" : undefined,
            }}
          >
            {i + 1}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column" }}>
        <div
          ref={editorRef}
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "14px",
            lineHeight: "1.5",
            padding: "16px",
            borderRadius: "0 8px 8px 0",
            outline: "none",
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
            backgroundColor: theme === "dark" ? "#1e1e1e" : "#f5f5f5",
            color: theme === "dark" ? "#d4d4d4" : "#333",
            minHeight: "200px",
            flex: 1,
          }}
          contentEditable={!readOnly}
          spellCheck={false}
        />
        {errors.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              pointerEvents: "none",
              fontFamily: "ui-monospace, monospace",
              fontSize: "14px",
              lineHeight: "1.5",
              padding: "16px",
            }}
          >
            {lines.map((_, i) => (
              <div key={i} style={{ position: "relative" }}>
                {errorsByLine.has(i + 1) && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      backgroundColor: "rgba(248, 113, 113, 0.1)",
                      borderLeft: "3px solid #f87171",
                      marginLeft: "-16px",
                      paddingLeft: "13px",
                      height: "1.5em",
                    }}
                  />
                )}
                <span style={{ visibility: "hidden" }}>{lines[i] || " "}</span>
              </div>
            ))}
          </div>
        )}
        {showAutocomplete && autocompleteItems.length > 0 && (
          <div className="absolute z-50 flex" style={{ top: autocompletePos.top, left: Math.max(0, autocompletePos.left - 100) }}>
            <div
              ref={autocompleteRef}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                "border rounded shadow-lg max-h-72 overflow-auto",
                theme === "dark" ? "bg-neutral-800 border-neutral-600" : "bg-white border-neutral-300"
              )}
              style={{ minWidth: "280px", maxWidth: "400px" }}
            >
              <div className="sticky top-0 px-2 py-1 text-xs text-foreground/40 border-b border-foreground/10 bg-inherit">
                {autocompleteItems.length} items (↑↓ navigate, Enter select, Esc close)
              </div>
              {autocompleteItems.map((item, i) => (
                <div
                  key={item.label}
                  data-index={i}
                  className={cn(
                    "px-3 py-1.5 cursor-pointer text-sm font-mono",
                    i === autocompleteIndex
                      ? theme === "dark" ? "bg-neutral-700" : "bg-neutral-100"
                      : "",
                    theme === "dark" ? "hover:bg-neutral-700" : "hover:bg-neutral-100"
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    insertSuggestion(item)
                  }}
                  onMouseEnter={() => {
                    setAutocompleteIndex(i)
                    setHoverItem(item)
                  }}
                  onMouseLeave={() => setHoverItem(null)}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-xs px-1 rounded",
                      item.kind === "tx" ? "bg-pink-500/20 text-pink-400"
                        : item.kind === "query" ? "bg-blue-500/20 text-blue-400"
                        : item.kind === "event" ? "bg-yellow-500/20 text-yellow-400"
                        : item.kind === "error" ? "bg-red-500/20 text-red-400"
                        : item.kind === "api" ? "bg-purple-500/20 text-purple-400"
                        : "bg-green-500/20 text-green-400"
                    )}>
                      {item.kind}
                    </span>
                    <span>{item.label}</span>
                  </div>
                  {item.docs && (
                    <div className="text-xs text-foreground/50 mt-0.5 line-clamp-1">
                      {item.docs}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* hover tooltip showing field types */}
            {hoverItem?.fields && hoverItem.fields.length > 0 && (
              <div
                className={cn(
                  "ml-2 border rounded shadow-lg p-2 max-h-72 overflow-auto",
                  theme === "dark" ? "bg-neutral-800 border-neutral-600" : "bg-white border-neutral-300"
                )}
                style={{ minWidth: "200px", maxWidth: "300px" }}
              >
                <div className="text-xs text-foreground/60 mb-1 font-medium">
                  {hoverItem.kind === "tx" || hoverItem.kind === "api" ? "Parameters:" : "Fields:"}
                </div>
                {hoverItem.fields.map((f, i) => (
                  <div key={i} className="text-xs font-mono py-0.5">
                    <span className="text-polkadot-400">{f.name}</span>
                    <span className="text-foreground/40">: </span>
                    <span className="text-foreground/70">{f.type}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
