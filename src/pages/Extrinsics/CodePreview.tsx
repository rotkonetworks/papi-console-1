import { FC, useMemo, useState } from "react"
import { useNavigate } from "@/hashParams"
import { Copy, Check, Plus } from "lucide-react"
import { ActionButton } from "@/components/ActionButton"
import { appendToScript } from "@/state/script.state"
import { useTheme } from "@/ThemeProvider"
import { generateTxCode, decodeCallData } from "@/utils/codegen"
import { cn } from "@/lib/utils"
import Prism from "prismjs"
import "prismjs/components/prism-typescript"

export const CodePreview: FC<{
  callData: Uint8Array | string | null
  decode: (value: Uint8Array) => unknown
}> = ({ callData, decode }) => {
  const theme = useTheme()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)

  const { decoded, code } = useMemo(() => {
    if (!callData) return { decoded: null, code: "" }
    const decoded = decodeCallData(callData, decode)
    if (!decoded) return { decoded: null, code: "// error decoding call data" }
    return { decoded, code: generateTxCode(decoded) }
  }, [callData, decode])

  const { highlighted, lines } = useMemo(() => ({
    highlighted: Prism.highlight(code, Prism.languages.typescript, "typescript"),
    lines: code.split("\n"),
  }), [code])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleAddToScript = () => {
    if (code) {
      appendToScript(code)
      navigate("/script")
    }
  }

  if (!callData) {
    return (
      <div className="flex-1 flex items-center justify-center text-foreground/50 p-4">
        Build an extrinsic to see the code
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 overflow-auto p-2 flex-1">
      <div className="flex gap-2 items-center">
        <ActionButton onClick={handleCopy} className="flex items-center gap-1">
          {copied ? <Check size={16} /> : <Copy size={16} />}
          copy
        </ActionButton>
        <ActionButton
          onClick={handleAddToScript}
          disabled={!decoded}
          className="flex items-center gap-1"
          title="Add to script editor"
        >
          <Plus size={16} />
          add to script
        </ActionButton>
      </div>

      <div className="flex-1 overflow-auto border rounded flex">
        <div
          className={cn(
            "font-mono text-sm leading-relaxed py-4 px-2 text-right select-none min-w-[3em] rounded-l-lg",
            theme === "dark" ? "text-neutral-500 bg-neutral-900" : "text-neutral-400 bg-neutral-200"
          )}
        >
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre
          className={cn(
            "flex-1 font-mono text-sm leading-relaxed p-4 m-0 rounded-r-lg overflow-auto",
            theme === "dark" ? "bg-neutral-800 text-neutral-200" : "bg-neutral-100 text-neutral-800"
          )}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </div>
    </div>
  )
}
