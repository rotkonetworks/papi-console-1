import { state } from "@react-rxjs/core"
import { BehaviorSubject } from "rxjs"

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

// use BehaviorSubject so state persists across navigations
const script$$ = new BehaviorSubject<string>(loadScript())

export const setScript = (value: string) => {
  saveScript(value)
  script$$.next(value)
}

export const appendToScript = (value: string) => {
  const current = script$$.getValue()
  const sep = current.trim() ? "\n\n" : ""
  const newScript = current + sep + value
  saveScript(newScript)
  script$$.next(newScript)
}

export const script$ = state(script$$, loadScript())

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
