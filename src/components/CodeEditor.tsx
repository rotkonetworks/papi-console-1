import { useTheme } from "@/ThemeProvider"
import { CodeJar } from "codejar"
import Prism from "prismjs"
import "prismjs/components/prism-typescript"
import "prismjs/themes/prism-tomorrow.css"
import { FC, useCallback, useEffect, useRef } from "react"

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

export const CodeEditor: FC<{
  value: string
  onChange: (value: string) => void
  className?: string
  readOnly?: boolean
  errors?: CodeError[]
}> = ({ value, onChange, className, readOnly, errors = [] }) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const jarRef = useRef<ReturnType<typeof CodeJar> | null>(null)
  const theme = useTheme()

  // undo/redo history
  const historyRef = useRef<string[]>([value])
  const historyIndexRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUndoRedoRef = useRef(false)

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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

  useEffect(() => {
    if (!editorRef.current) return

    const jar = CodeJar(editorRef.current, highlight, {
      tab: "  ",
      indentOn: /[{[(]$/,
      addClosing: true,
    })

    jar.updateCode(value)
    jar.onUpdate((newValue) => {
      onChange(newValue)
      pushHistory(newValue)
    })
    jarRef.current = jar

    return () => {
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
      <div style={{ flex: 1, position: "relative" }}>
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
      </div>
    </div>
  )
}
