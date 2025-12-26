import { Binary } from "polkadot-api"

type DecodedEnum = { type: string; value: unknown }

const isEnum = (v: unknown): v is DecodedEnum =>
  v !== null &&
  typeof v === "object" &&
  "type" in v &&
  "value" in v &&
  typeof (v as DecodedEnum).type === "string"

const formatValue = (v: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent)
  const padInner = "  ".repeat(indent + 1)

  if (v === null || v === undefined) return "null"
  if (typeof v === "bigint") return `${v}n`
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)

  if (v instanceof Uint8Array) {
    return `Binary.fromHex("${Array.from(v).map(b => b.toString(16).padStart(2, "0")).join("")}")`
  }

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]"
    const items = v.map(item => formatValue(item, indent + 1))
    if (items.join(", ").length < 60 && !items.some(i => i.includes("\n"))) {
      return `[${items.join(", ")}]`
    }
    return `[\n${items.map(i => `${padInner}${i}`).join(",\n")},\n${pad}]`
  }

  if (isEnum(v)) {
    const inner = formatValue(v.value, indent + 1)
    if (v.value === undefined || v.value === null) {
      return `{ type: "${v.type}" }`
    }
    if (inner.includes("\n")) {
      return `{\n${padInner}type: "${v.type}",\n${padInner}value: ${inner},\n${pad}}`
    }
    return `{ type: "${v.type}", value: ${inner} }`
  }

  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return "{}"

    const formatted = entries.map(([k, val]) => {
      const formattedVal = formatValue(val, indent + 1)
      return `${padInner}${k}: ${formattedVal}`
    })

    if (formatted.join(", ").length < 60 && !formatted.some(f => f.includes("\n"))) {
      return `{ ${entries.map(([k, val]) => `${k}: ${formatValue(val, 0)}`).join(", ")} }`
    }

    return `{\n${formatted.join(",\n")},\n${pad}}`
  }

  return String(v)
}

export const generateTxCode = (decoded: unknown): string => {
  if (!isEnum(decoded)) {
    return `// could not parse call structure\n// raw: ${JSON.stringify(decoded, null, 2)}`
  }

  const pallet = decoded.type
  const call = decoded.value

  if (!isEnum(call)) {
    return `// unexpected call structure for ${pallet}\n// raw: ${JSON.stringify(decoded, null, 2)}`
  }

  const method = call.type
  const args = call.value

  const formattedArgs = formatValue(args, 0)

  return `const tx = api.tx.${pallet}.${method}(${formattedArgs})

await tx.signAndSubmit(signer)
console.log("done")`
}

export const decodeCallData = (
  callData: Uint8Array | string,
  decode: (value: Uint8Array) => unknown,
): unknown | null => {
  try {
    const bytes =
      typeof callData === "string" ? Binary.fromHex(callData).asBytes() : callData
    return decode(bytes)
  } catch {
    return null
  }
}
