import { BinaryDisplay } from "@/codec-components/LookupTypeEdit"
import { LoadingMetadata } from "@/components/Loading"
import { withSubscribe } from "@/components/withSuspense"
import { getHashParams, setHashParams, Link } from "@/hashParams"
import { runtimeCtx$ } from "@/state/chains/chain.state"
import {
  CodecComponentType,
  CodecComponentValue,
} from "@polkadot-api/react-builder"
import { Binary } from "@polkadot-api/substrate-bindings"
import { toHex } from "@polkadot-api/utils"
import { state, useStateObservable } from "@react-rxjs/core"
import { useLayoutEffect, useState } from "react"
import { useLocation, Routes, Route } from "react-router-dom"
import { map } from "rxjs"
import { twMerge } from "tailwind-merge"
import { EditMode } from "./EditMode"
import { JsonMode } from "./JsonMode"
import { CodePreview } from "./CodePreview"
import { ExtrinsicModal } from "./SubmitTx/SubmitTx"
import { ActionButton } from "@/components/ActionButton"
import { Settings } from "lucide-react"
import { CustomSignedExt, customSignedExtensions$ } from "./CustomSignedExt"

const extrinsicProps$ = state(
  runtimeCtx$.pipe(
    map(({ dynamicBuilder, lookup }) => {
      const codecType =
        "call" in lookup.metadata.extrinsic
          ? lookup.metadata.extrinsic.call
          : // TODO v14 is this one?
            lookup.metadata.extrinsic.type
      return {
        metadata: lookup.metadata,
        codecType,
        codec: dynamicBuilder.buildDefinition(codecType),
      }
    }),
  ),
)

const customExtensionsCount$ = state(
  customSignedExtensions$.pipe(
    map((v) => Object.keys(v).length),
    map((v) =>
      v ? (
        <div className="px-1.5 rounded-full bg-chart-1 text-white text-sm">
          {v}
        </div>
      ) : null,
    ),
  ),
  null,
)

const TabLink = ({
  to,
  children,
  active,
  disabled,
}: {
  to: string
  children: React.ReactNode
  active: boolean
  disabled?: boolean
}) => (
  <Link
    to={to}
    className={twMerge(
      "px-3 py-1 text-secondary-foreground hover:text-polkadot-500 font-light",
      active && "bg-accent text-accent-foreground font-bold",
      disabled && "opacity-50 pointer-events-none",
    )}
  >
    {children}
  </Link>
)

export const Extrinsics = withSubscribe(
  () => {
    const [editingExtensions, setEditingExtensions] = useState(false)
    const extrinsicProps = useStateObservable(extrinsicProps$)
    const location = useLocation()

    const [componentValue, setComponentValue] = useState<CodecComponentValue>({
      type: CodecComponentType.Initial,
      value: getHashParams(location).get("data") ?? "",
    })
    const binaryValue =
      (componentValue.type === CodecComponentType.Initial
        ? componentValue.value
        : componentValue.value.empty
          ? null
          : componentValue.value.encoded) ?? null

    useLayoutEffect(() => {
      if (binaryValue && binaryValue.length < 1024 * 1024) {
        setHashParams({
          data:
            typeof binaryValue === "string" ? binaryValue : toHex(binaryValue),
        })
      } else {
        setHashParams({
          data: null,
        })
      }
    }, [binaryValue])

    const currentTab = location.pathname.split("/").pop() || "builder"
    const isBuilder = currentTab === "builder" || currentTab === "extrinsics"
    const isJson = currentTab === "json"
    const isCode = currentTab === "code"

    if (editingExtensions)
      return <CustomSignedExt onClose={() => setEditingExtensions(false)} />

    return (
      <div
        className={twMerge(
          "flex flex-col overflow-hidden gap-2 p-4 pb-0",
          // Bypassing top-level scroll area, since we need a specific scroll area for the tree view
          "absolute w-full h-full max-w-(--breakpoint-xl)",
        )}
      >
        <BinaryDisplay
          {...extrinsicProps}
          value={componentValue}
          onUpdate={(value) =>
            setComponentValue({ type: CodecComponentType.Updated, value })
          }
        />

        <div className="flex flex-row justify-between px-2">
          <nav className="inline-flex border border-accent bg-background text-foreground">
            <TabLink to="/extrinsics/builder" active={isBuilder}>
              Builder
            </TabLink>
            <TabLink to="/extrinsics/json" active={isJson} disabled={!binaryValue}>
              JSON
            </TabLink>
            <TabLink to="/extrinsics/code" active={isCode}>
              Code
            </TabLink>
          </nav>
          <div className="flex flex-row items-center gap-2">
            <ActionButton
              className="text-foreground/70 flex items-center gap-1"
              onClick={() => setEditingExtensions(true)}
            >
              {customExtensionsCount$}
              <Settings />
            </ActionButton>
            <ExtrinsicModal callData={binaryValue ?? undefined} />
          </div>
        </div>

        <Routes>
          <Route
            path="json"
            element={
              <JsonMode
                value={
                  typeof binaryValue === "string"
                    ? Binary.fromHex(binaryValue).asBytes()
                    : binaryValue
                }
                decode={extrinsicProps.codec.dec}
              />
            }
          />
          <Route
            path="code"
            element={
              <CodePreview
                callData={binaryValue}
                decode={extrinsicProps.codec.dec}
              />
            }
          />
          <Route
            path="*"
            element={
              <EditMode
                {...extrinsicProps}
                value={componentValue}
                onUpdate={(value) =>
                  setComponentValue({ type: CodecComponentType.Updated, value })
                }
              />
            }
          />
        </Routes>
      </div>
    )
  },
  {
    fallback: <LoadingMetadata />,
  },
)
