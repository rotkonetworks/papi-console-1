import { withDefault } from "@react-rxjs/core"
import { combineLatest, map, switchMap } from "rxjs"
import { client$ } from "./chains/chain.state"

export const chainProperties$ = client$.pipeState(
  switchMap((v) =>
    combineLatest([
      v.getChainSpecData().then((r) => r.properties),
      v
        .getUnsafeApi()
        .constants.System.SS58Prefix()
        .catch(() => null) as Promise<number | null>,
    ]),
  ),
  map(
    ([properties, ss58Ct]): {
      ss58Format?: number
      tokenDecimals?: number
      tokenSymbol?: string
    } => {
      const ss58Format = ss58Ct ?? properties?.ss58Format

      if (properties && typeof properties === "object") {
        const { tokenDecimals, tokenSymbol } = properties

        return {
          ss58Format,
          tokenDecimals,
          tokenSymbol,
        }
      }
      return { ss58Format }
    },
  ),
  withDefault(null),
)
