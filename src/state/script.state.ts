import { state } from "@react-rxjs/core"
import { createSignal } from "@react-rxjs/utils"
import { map, merge, scan, startWith } from "rxjs"

const STORAGE_KEY = "papi-console:script"

const loadScript = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

const saveScript = (script: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, script)
  } catch {
    // localStorage may be unavailable in some contexts
  }
}

const [scriptChange$, setScript] = createSignal<string>()
const [appendScript$, appendToScript] = createSignal<string>()

export { setScript, appendToScript }

export const script$ = state(
  merge(
    scriptChange$.pipe(map(s => ({ type: "set" as const, value: s }))),
    appendScript$.pipe(map(s => ({ type: "append" as const, value: s }))),
  ).pipe(
    startWith({ type: "set" as const, value: loadScript() }),
    scan((acc, action) => {
      if (action.type === "set") {
        return action.value
      } else {
        // append with newlines
        const sep = acc.trim() ? "\n\n" : ""
        return acc + sep + action.value
      }
    }, ""),
    map(script => {
      saveScript(script)
      return script
    }),
  ),
  loadScript(),
)

// helper to generate tx code from decoded call
export const generateTxCode = (pallet: string, call: string, args: string): string => {
  return `const tx = api.tx.${pallet}.${call}(${args})
await tx.signAndSubmit(signer)
console.log("done")`
}

// helper to generate query code
export const generateQueryCode = (pallet: string, entry: string, key?: string): string => {
  const keyArg = key ? key : ""
  return `const result = await api.query.${pallet}.${entry}(${keyArg})
console.log(result)`
}
