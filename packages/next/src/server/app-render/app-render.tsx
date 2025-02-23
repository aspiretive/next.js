import type {
  ActionResult,
  DynamicParamTypesShort,
  FlightRouterState,
  FlightSegmentPath,
  RenderOpts,
  Segment,
  CacheNodeSeedData,
  PreloadCallbacks,
  RSCPayload,
  FlightData,
  InitialRSCPayload,
} from './types'
import type { StaticGenerationStore } from '../../client/components/static-generation-async-storage.external'
import type { RequestStore } from '../../client/components/request-async-storage.external'
import type { NextParsedUrlQuery } from '../request-meta'
import type { LoaderTree } from '../lib/app-dir-module'
import type { AppPageModule } from '../route-modules/app-page/module'
import type { ClientReferenceManifest } from '../../build/webpack/plugins/flight-manifest-plugin'
import type { Revalidate } from '../lib/revalidate'
import type { DeepReadonly } from '../../shared/lib/deep-readonly'
import type { BaseNextRequest, BaseNextResponse } from '../base-http'
import type { IncomingHttpHeaders } from 'http'

import React, { type ErrorInfo, type JSX } from 'react'

import RenderResult, {
  type AppPageRenderResultMetadata,
  type RenderResultOptions,
} from '../render-result'
import {
  chainStreams,
  renderToInitialFizzStream,
  createDocumentClosingStream,
  continueFizzStream,
  continueDynamicPrerender,
  continueStaticPrerender,
  continueDynamicHTMLResume,
  streamToBuffer,
  streamToString,
} from '../stream-utils/node-web-streams-helper'
import { stripInternalQueries } from '../internal-utils'
import {
  NEXT_HMR_REFRESH_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL,
  RSC_HEADER,
} from '../../client/components/app-router-headers'
import {
  createMetadataComponents,
  createTrackedMetadataContext,
  createMetadataContext,
} from '../../lib/metadata/metadata'
import { withRequestStore } from '../async-storage/with-request-store'
import { withStaticGenerationStore } from '../async-storage/with-static-generation-store'
import { isNotFoundError } from '../../client/components/not-found'
import {
  getURLFromRedirectError,
  isRedirectError,
  getRedirectStatusCodeFromError,
} from '../../client/components/redirect'
import { addImplicitTags } from '../lib/patch-fetch'
import { AppRenderSpan, NextNodeServerSpan } from '../lib/trace/constants'
import { getTracer } from '../lib/trace/tracer'
import { FlightRenderResult } from './flight-render-result'
import {
  createFlightReactServerErrorHandler,
  createHTMLReactServerErrorHandler,
  createHTMLErrorHandler,
  type DigestedError,
  isUserLandError,
} from './create-error-handler'
import {
  getShortDynamicParamType,
  dynamicParamTypes,
} from './get-short-dynamic-param-type'
import { getSegmentParam } from './get-segment-param'
import { getScriptNonceFromHeader } from './get-script-nonce-from-header'
import { parseAndValidateFlightRouterState } from './parse-and-validate-flight-router-state'
import { createFlightRouterStateFromLoaderTree } from './create-flight-router-state-from-loader-tree'
import { handleAction } from './action-handler'
import { isBailoutToCSRError } from '../../shared/lib/lazy-dynamic/bailout-to-csr'
import { warn, error } from '../../build/output/log'
import { appendMutableCookies } from '../web/spec-extension/adapters/request-cookies'
import { createServerInsertedHTML } from './server-inserted-html'
import { getRequiredScripts } from './required-scripts'
import { addPathPrefix } from '../../shared/lib/router/utils/add-path-prefix'
import {
  getTracedMetadata,
  makeGetServerInsertedHTML,
} from './make-get-server-inserted-html'
import { walkTreeWithFlightRouterState } from './walk-tree-with-flight-router-state'
import { createComponentTree } from './create-component-tree'
import { getAssetQueryString } from './get-asset-query-string'
import { setReferenceManifestsSingleton } from './encryption-utils'
import {
  DynamicState,
  type PostponedState,
  parsePostponedState,
} from './postponed-state'
import {
  getDynamicDataPostponedState,
  getDynamicHTMLPostponedState,
  getPostponedFromState,
} from './postponed-state'
import { isDynamicServerError } from '../../client/components/hooks-server-context'
import {
  useFlightStream,
  createInlinedDataReadableStream,
} from './use-flight-response'
import {
  StaticGenBailoutError,
  isStaticGenBailoutError,
} from '../../client/components/static-generation-bailout'
import { getStackWithoutErrorMessage } from '../../lib/format-server-error'
import {
  accessedDynamicData,
  createPostponedAbortSignal,
  formatDynamicAPIAccesses,
  isPrerenderInterruptedError,
  isRenderInterruptedReason,
  createDynamicTrackingState,
  getFirstDynamicReason,
  type DynamicTrackingState,
} from './dynamic-rendering'
import {
  getClientComponentLoaderMetrics,
  wrapClientComponentLoader,
} from '../client-component-renderer-logger'
import { createServerModuleMap } from './action-utils'
import { isNodeNextRequest } from '../base-http/helpers'
import { parseParameter } from '../../shared/lib/router/utils/route-regex'
import { parseRelativeUrl } from '../../shared/lib/router/utils/parse-relative-url'
import AppRouter from '../../client/components/app-router'
import type { ServerComponentsHmrCache } from '../response-cache'
import type { RequestErrorContext } from '../instrumentation/types'
import { getServerActionRequestMetadata } from '../lib/server-action-request-meta'
import { createInitialRouterState } from '../../client/components/router-reducer/create-initial-router-state'
import { createMutableActionQueue } from '../../shared/lib/router/action-queue'
import { getRevalidateReason } from '../instrumentation/utils'
import { PAGE_SEGMENT_KEY } from '../../shared/lib/segment'
import type { FallbackRouteParams } from '../../client/components/fallback-params'
import { DynamicServerError } from '../../client/components/hooks-server-context'
import {
  type ReactServerPrerenderResolveToType,
  type ReactServerPrerenderResult,
  ReactServerResult,
  createReactServerPrerenderResult,
  createReactServerPrerenderResultFromRender,
  prerenderAndAbortInSequentialTasks,
} from '../app-render/app-render-prerender-utils'
import { waitAtLeastOneReactRenderTask } from '../../lib/scheduler'
import {
  prerenderAsyncStorage,
  type PrerenderStore,
} from './prerender-async-storage.external'
import { CacheSignal } from './cache-signal'

export type GetDynamicParamFromSegment = (
  // [slug] / [[slug]] / [...slug]
  segment: string
) => {
  param: string
  value: string | string[] | null
  treeSegment: Segment
  type: DynamicParamTypesShort
} | null

export type GenerateFlight = typeof generateDynamicFlightRenderResult

export type AppRenderContext = {
  staticGenerationStore: StaticGenerationStore
  requestStore: RequestStore
  componentMod: AppPageModule
  renderOpts: RenderOpts
  parsedRequestHeaders: ParsedRequestHeaders
  getDynamicParamFromSegment: GetDynamicParamFromSegment
  query: NextParsedUrlQuery
  isPrefetch: boolean
  isAction: boolean
  requestTimestamp: number
  appUsingSizeAdjustment: boolean
  flightRouterState?: FlightRouterState
  requestId: string
  defaultRevalidate: Revalidate
  pagePath: string
  clientReferenceManifest: DeepReadonly<ClientReferenceManifest>
  assetPrefix: string
  isNotFoundPath: boolean
  nonce: string | undefined
  res: BaseNextResponse
}

interface ParseRequestHeadersOptions {
  readonly isRoutePPREnabled: boolean
}

const flightDataPathHeadKey = 'h'

interface ParsedRequestHeaders {
  /**
   * Router state provided from the client-side router. Used to handle rendering
   * from the common layout down. This value will be undefined if the request is
   * not a client-side navigation request, or if the request is a prefetch
   * request.
   */
  readonly flightRouterState: FlightRouterState | undefined
  readonly isPrefetchRequest: boolean
  readonly isHmrRefresh: boolean
  readonly isRSCRequest: boolean
  readonly nonce: string | undefined
}

function parseRequestHeaders(
  headers: IncomingHttpHeaders,
  options: ParseRequestHeadersOptions
): ParsedRequestHeaders {
  const isPrefetchRequest =
    headers[NEXT_ROUTER_PREFETCH_HEADER.toLowerCase()] !== undefined

  const isHmrRefresh =
    headers[NEXT_HMR_REFRESH_HEADER.toLowerCase()] !== undefined

  const isRSCRequest = headers[RSC_HEADER.toLowerCase()] !== undefined

  const shouldProvideFlightRouterState =
    isRSCRequest && (!isPrefetchRequest || !options.isRoutePPREnabled)

  const flightRouterState = shouldProvideFlightRouterState
    ? parseAndValidateFlightRouterState(
        headers[NEXT_ROUTER_STATE_TREE_HEADER.toLowerCase()]
      )
    : undefined

  const csp =
    headers['content-security-policy'] ||
    headers['content-security-policy-report-only']

  const nonce =
    typeof csp === 'string' ? getScriptNonceFromHeader(csp) : undefined

  return {
    flightRouterState,
    isPrefetchRequest,
    isHmrRefresh,
    isRSCRequest,
    nonce,
  }
}

function createNotFoundLoaderTree(loaderTree: LoaderTree): LoaderTree {
  // Align the segment with parallel-route-default in next-app-loader
  const components = loaderTree[2]
  return [
    '',
    {
      children: [
        PAGE_SEGMENT_KEY,
        {},
        {
          page: components['not-found'],
        },
      ],
    },
    components,
  ]
}

export type CreateSegmentPath = (child: FlightSegmentPath) => FlightSegmentPath

/**
 * Returns a function that parses the dynamic segment and return the associated value.
 */
function makeGetDynamicParamFromSegment(
  params: { [key: string]: any },
  pagePath: string,
  fallbackRouteParams: FallbackRouteParams | null
): GetDynamicParamFromSegment {
  return function getDynamicParamFromSegment(
    // [slug] / [[slug]] / [...slug]
    segment: string
  ) {
    const segmentParam = getSegmentParam(segment)
    if (!segmentParam) {
      return null
    }

    const key = segmentParam.param

    let value = params[key]

    if (fallbackRouteParams && fallbackRouteParams.has(segmentParam.param)) {
      value = fallbackRouteParams.get(segmentParam.param)
    } else if (Array.isArray(value)) {
      value = value.map((i) => encodeURIComponent(i))
    } else if (typeof value === 'string') {
      value = encodeURIComponent(value)
    }

    if (!value) {
      const isCatchall = segmentParam.type === 'catchall'
      const isOptionalCatchall = segmentParam.type === 'optional-catchall'

      if (isCatchall || isOptionalCatchall) {
        const dynamicParamType = dynamicParamTypes[segmentParam.type]
        // handle the case where an optional catchall does not have a value,
        // e.g. `/dashboard/[[...slug]]` when requesting `/dashboard`
        if (isOptionalCatchall) {
          return {
            param: key,
            value: null,
            type: dynamicParamType,
            treeSegment: [key, '', dynamicParamType],
          }
        }

        // handle the case where a catchall or optional catchall does not have a value,
        // e.g. `/foo/bar/hello` and `@slot/[...catchall]` or `@slot/[[...catchall]]` is matched
        value = pagePath
          .split('/')
          // remove the first empty string
          .slice(1)
          // replace any dynamic params with the actual values
          .flatMap((pathSegment) => {
            const param = parseParameter(pathSegment)
            // if the segment matches a param, return the param value
            // otherwise, it's a static segment, so just return that
            return params[param.key] ?? param.key
          })

        return {
          param: key,
          value,
          type: dynamicParamType,
          // This value always has to be a string.
          treeSegment: [key, value.join('/'), dynamicParamType],
        }
      }
    }

    const type = getShortDynamicParamType(segmentParam.type)

    return {
      param: key,
      // The value that is passed to user code.
      value: value,
      // The value that is rendered in the router tree.
      treeSegment: [key, Array.isArray(value) ? value.join('/') : value, type],
      type: type,
    }
  }
}

function NonIndex({ ctx }: { ctx: AppRenderContext }) {
  const is404Page = ctx.pagePath === '/404'
  const isInvalidStatusCode =
    typeof ctx.res.statusCode === 'number' && ctx.res.statusCode > 400

  if (is404Page || isInvalidStatusCode) {
    return <meta name="robots" content="noindex" />
  }
  return null
}

/**
 * This is used by server actions & client-side navigations to generate RSC data from a client-side request.
 * This function is only called on "dynamic" requests (ie, there wasn't already a static response).
 * It uses request headers (namely `Next-Router-State-Tree`) to determine where to start rendering.
 */
async function generateDynamicRSCPayload(
  ctx: AppRenderContext,
  options?: {
    actionResult: ActionResult
    skipFlight: boolean
  }
): Promise<RSCPayload> {
  // Flight data that is going to be passed to the browser.
  // Currently a single item array but in the future multiple patches might be combined in a single request.

  // We initialize `flightData` to an empty string because the client router knows how to tolerate
  // it (treating it as an MPA navigation). The only time this function wouldn't generate flight data
  // is for server actions, if the server action handler instructs this function to skip it. When the server
  // action reducer sees a falsy value, it'll simply resolve the action with no data.
  let flightData: FlightData = ''

  const {
    componentMod: {
      tree: loaderTree,
      createDynamicallyTrackedSearchParams,
      createDynamicallyTrackedParams,
    },
    getDynamicParamFromSegment,
    appUsingSizeAdjustment,
    requestStore: { url },
    query,
    requestId,
    flightRouterState,
    staticGenerationStore,
  } = ctx

  if (!options?.skipFlight) {
    const preloadCallbacks: PreloadCallbacks = []

    const [MetadataTree, getMetadataReady] = createMetadataComponents({
      tree: loaderTree,
      query,
      metadataContext: createTrackedMetadataContext(
        url.pathname,
        ctx.renderOpts,
        staticGenerationStore
      ),
      getDynamicParamFromSegment,
      appUsingSizeAdjustment,
      createDynamicallyTrackedSearchParams,
      createDynamicallyTrackedParams,
    })
    flightData = (
      await walkTreeWithFlightRouterState({
        ctx,
        createSegmentPath: (child) => child,
        loaderTreeToFilter: loaderTree,
        parentParams: {},
        flightRouterState,
        isFirst: true,
        // For flight, render metadata inside leaf page
        rscPayloadHead: (
          <React.Fragment key={flightDataPathHeadKey}>
            <NonIndex ctx={ctx} />
            {/* Adding requestId as react key to make metadata remount for each render */}
            <MetadataTree key={requestId} />
          </React.Fragment>
        ),
        injectedCSS: new Set(),
        injectedJS: new Set(),
        injectedFontPreloadTags: new Set(),
        rootLayoutIncluded: false,
        getMetadataReady,
        preloadCallbacks,
      })
    ).map((path) => path.slice(1)) // remove the '' (root) segment
  }

  // If we have an action result, then this is a server action response.
  // We can rely on this because `ActionResult` will always be a promise, even if
  // the result is falsey.
  if (options?.actionResult) {
    return {
      a: options.actionResult,
      f: flightData,
      b: ctx.renderOpts.buildId,
    }
  }

  // Otherwise, it's a regular RSC response.
  return {
    b: ctx.renderOpts.buildId,
    f: flightData,
  }
}

function createErrorContext(
  ctx: AppRenderContext,
  renderSource: RequestErrorContext['renderSource']
): RequestErrorContext {
  return {
    routerKind: 'App Router',
    routePath: ctx.pagePath,
    routeType: ctx.isAction ? 'action' : 'render',
    renderSource,
    revalidateReason: getRevalidateReason(ctx.staticGenerationStore),
  }
}
/**
 * Produces a RenderResult containing the Flight data for the given request. See
 * `generateDynamicRSCPayload` for information on the contents of the render result.
 */
async function generateDynamicFlightRenderResult(
  req: BaseNextRequest,
  ctx: AppRenderContext,
  options?: {
    actionResult: ActionResult
    skipFlight: boolean
    componentTree?: CacheNodeSeedData
    preloadCallbacks?: PreloadCallbacks
  }
): Promise<RenderResult> {
  const renderOpts = ctx.renderOpts

  function onFlightDataRenderError(err: DigestedError) {
    return renderOpts.onInstrumentationRequestError?.(
      err,
      req,
      createErrorContext(ctx, 'react-server-components-payload')
    )
  }
  const onError = createFlightReactServerErrorHandler(
    !!renderOpts.dev,
    onFlightDataRenderError
  )

  const rscPayload = await generateDynamicRSCPayload(ctx, options)

  // For app dir, use the bundled version of Flight server renderer (renderToReadableStream)
  // which contains the subset React.
  const flightReadableStream = ctx.componentMod.renderToReadableStream(
    rscPayload,
    ctx.clientReferenceManifest.clientModules,
    {
      onError,
      nonce: ctx.nonce,
    }
  )

  return new FlightRenderResult(flightReadableStream, {
    fetchMetrics: ctx.staticGenerationStore.fetchMetrics,
  })
}

/**
 * Crawlers will inadvertently think the canonicalUrl in the RSC payload should be crawled
 * when our intention is to just seed the router state with the current URL.
 * This function splits up the pathname so that we can later join it on
 * when we're ready to consume the path.
 */
function prepareInitialCanonicalUrl(url: RequestStore['url']) {
  return (url.pathname + url.search).split('/')
}

// This is the data necessary to render <AppRouter /> when no SSR errors are encountered
async function getRSCPayload(
  tree: LoaderTree,
  ctx: AppRenderContext,
  is404: boolean
): Promise<InitialRSCPayload & { P: React.ReactNode }> {
  const injectedCSS = new Set<string>()
  const injectedJS = new Set<string>()
  const injectedFontPreloadTags = new Set<string>()
  let missingSlots: Set<string> | undefined

  // We only track missing parallel slots in development
  if (process.env.NODE_ENV === 'development') {
    missingSlots = new Set<string>()
  }

  const {
    getDynamicParamFromSegment,
    query,
    appUsingSizeAdjustment,
    componentMod: {
      GlobalError,
      createDynamicallyTrackedSearchParams,
      createDynamicallyTrackedParams,
    },
    requestStore: { url },
    staticGenerationStore,
  } = ctx
  const initialTree = createFlightRouterStateFromLoaderTree(
    tree,
    getDynamicParamFromSegment,
    query
  )

  const [MetadataTree, getMetadataReady] = createMetadataComponents({
    tree,
    errorType: is404 ? 'not-found' : undefined,
    query,
    metadataContext: createTrackedMetadataContext(
      url.pathname,
      ctx.renderOpts,
      staticGenerationStore
    ),
    getDynamicParamFromSegment,
    appUsingSizeAdjustment,
    createDynamicallyTrackedSearchParams,
    createDynamicallyTrackedParams,
  })

  const preloadCallbacks: PreloadCallbacks = []

  const seedData = await createComponentTree({
    ctx,
    createSegmentPath: (child) => child,
    loaderTree: tree,
    parentParams: {},
    firstItem: true,
    injectedCSS,
    injectedJS,
    injectedFontPreloadTags,
    rootLayoutIncluded: false,
    getMetadataReady,
    missingSlots,
    preloadCallbacks,
  })

  // When the `vary` response header is present with `Next-URL`, that means there's a chance
  // it could respond differently if there's an interception route. We provide this information
  // to `AppRouter` so that it can properly seed the prefetch cache with a prefix, if needed.
  const varyHeader = ctx.res.getHeader('vary')
  const couldBeIntercepted =
    typeof varyHeader === 'string' && varyHeader.includes(NEXT_URL)

  const initialHead = (
    <React.Fragment key={flightDataPathHeadKey}>
      <NonIndex ctx={ctx} />
      {/* Adding requestId as react key to make metadata remount for each render */}
      <MetadataTree key={ctx.requestId} />
    </React.Fragment>
  )

  return {
    // See the comment above the `Preloads` component (below) for why this is part of the payload
    P: <Preloads preloadCallbacks={preloadCallbacks} />,
    b: ctx.renderOpts.buildId,
    p: ctx.assetPrefix,
    c: prepareInitialCanonicalUrl(url),
    i: !!couldBeIntercepted,
    f: [[initialTree, seedData, initialHead]],
    m: missingSlots,
    G: GlobalError,
    s: typeof ctx.renderOpts.postponed === 'string',
  }
}

/**
 * Preload calls (such as `ReactDOM.preloadStyle` and `ReactDOM.preloadFont`) need to be called during rendering
 * in order to create the appropriate preload tags in the DOM, otherwise they're a no-op. Since we invoke
 * renderToReadableStream with a function that returns component props rather than a component itself, we use
 * this component to "render  " the preload calls.
 */
function Preloads({ preloadCallbacks }: { preloadCallbacks: Function[] }) {
  preloadCallbacks.forEach((preloadFn) => preloadFn())
  return null
}

// This is the data necessary to render <AppRouter /> when an error state is triggered
async function getErrorRSCPayload(
  tree: LoaderTree,
  ctx: AppRenderContext,
  errorType: 'not-found' | 'redirect' | undefined
) {
  const {
    getDynamicParamFromSegment,
    query,
    appUsingSizeAdjustment,
    componentMod: {
      GlobalError,
      createDynamicallyTrackedSearchParams,
      createDynamicallyTrackedParams,
    },
    requestStore: { url },
    requestId,
  } = ctx

  const [MetadataTree] = createMetadataComponents({
    tree,
    // We create an untracked metadata context here because we can't postpone
    // again during the error render.
    metadataContext: createMetadataContext(url.pathname, ctx.renderOpts),
    errorType,
    query,
    getDynamicParamFromSegment,
    appUsingSizeAdjustment,
    createDynamicallyTrackedSearchParams,
    createDynamicallyTrackedParams,
  })

  const initialHead = (
    <React.Fragment key={flightDataPathHeadKey}>
      <NonIndex ctx={ctx} />
      {/* Adding requestId as react key to make metadata remount for each render */}
      <MetadataTree key={requestId} />
      {process.env.NODE_ENV === 'development' && (
        <meta name="next-error" content="not-found" />
      )}
    </React.Fragment>
  )

  const initialTree = createFlightRouterStateFromLoaderTree(
    tree,
    getDynamicParamFromSegment,
    query
  )

  // For metadata notFound error there's no global not found boundary on top
  // so we create a not found page with AppRouter
  const initialSeedData: CacheNodeSeedData = [
    initialTree[0],
    <html id="__next_error__">
      <head></head>
      <body></body>
    </html>,
    {},
    null,
  ]

  return {
    b: ctx.renderOpts.buildId,
    p: ctx.assetPrefix,
    c: prepareInitialCanonicalUrl(url),
    m: undefined,
    i: false,
    f: [[initialTree, initialSeedData, initialHead]],
    G: GlobalError,
    s: typeof ctx.renderOpts.postponed === 'string',
  } satisfies InitialRSCPayload
}

// This component must run in an SSR context. It will render the RSC root component
function App<T>({
  reactServerStream,
  preinitScripts,
  clientReferenceManifest,
  nonce,
  ServerInsertedHTMLProvider,
}: {
  reactServerStream: BinaryStreamOf<T>
  preinitScripts: () => void
  clientReferenceManifest: NonNullable<RenderOpts['clientReferenceManifest']>
  ServerInsertedHTMLProvider: React.ComponentType<{ children: JSX.Element }>
  nonce?: string
}): JSX.Element {
  preinitScripts()
  const response = React.use(
    useFlightStream<InitialRSCPayload>(
      reactServerStream,
      clientReferenceManifest,
      nonce
    )
  )

  const initialState = createInitialRouterState({
    buildId: response.b,
    initialFlightData: response.f,
    initialCanonicalUrlParts: response.c,
    // location and initialParallelRoutes are not initialized in the SSR render
    // they are set to an empty map and window.location, respectively during hydration
    initialParallelRoutes: null!,
    location: null,
    couldBeIntercepted: response.i,
    postponed: response.s,
  })

  const actionQueue = createMutableActionQueue(initialState)

  const { HeadManagerContext } =
    require('../../shared/lib/head-manager-context.shared-runtime') as typeof import('../../shared/lib/head-manager-context.shared-runtime')

  return (
    <HeadManagerContext.Provider
      value={{
        appDir: true,
        nonce,
      }}
    >
      <ServerInsertedHTMLProvider>
        <AppRouter
          actionQueue={actionQueue}
          globalErrorComponent={response.G}
          assetPrefix={response.p}
        />
      </ServerInsertedHTMLProvider>
    </HeadManagerContext.Provider>
  )
}

// @TODO our error stream should be probably just use the same root component. But it was previously
// different I don't want to figure out if that is meaningful at this time so just keeping the behavior
// consistent for now.
function AppWithoutContext<T>({
  reactServerStream,
  preinitScripts,
  clientReferenceManifest,
  nonce,
}: {
  reactServerStream: BinaryStreamOf<T>
  preinitScripts: () => void
  clientReferenceManifest: NonNullable<RenderOpts['clientReferenceManifest']>
  nonce?: string
}): JSX.Element {
  preinitScripts()
  const response = React.use(
    useFlightStream<InitialRSCPayload>(
      reactServerStream,
      clientReferenceManifest,
      nonce
    )
  )

  const initialState = createInitialRouterState({
    buildId: response.b,
    initialFlightData: response.f,
    initialCanonicalUrlParts: response.c,
    // location and initialParallelRoutes are not initialized in the SSR render
    // they are set to an empty map and window.location, respectively during hydration
    initialParallelRoutes: null!,
    location: null,
    couldBeIntercepted: response.i,
    postponed: response.s,
  })

  const actionQueue = createMutableActionQueue(initialState)

  return (
    <AppRouter
      actionQueue={actionQueue}
      globalErrorComponent={response.G}
      assetPrefix={response.p}
    />
  )
}

// We use a trick with TS Generics to branch streams with a type so we can
// consume the parsed value of a Readable Stream if it was constructed with a
// certain object shape. The generic type is not used directly in the type so it
// requires a disabling of the eslint rule disallowing unused vars
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type BinaryStreamOf<T> = ReadableStream<Uint8Array>

async function renderToHTMLOrFlightImpl(
  req: BaseNextRequest,
  res: BaseNextResponse,
  pagePath: string,
  query: NextParsedUrlQuery,
  renderOpts: RenderOpts,
  requestStore: RequestStore,
  staticGenerationStore: StaticGenerationStore,
  parsedRequestHeaders: ParsedRequestHeaders,
  requestEndedState: { ended?: boolean },
  postponedState: PostponedState | null
) {
  const isNotFoundPath = pagePath === '/404'
  if (isNotFoundPath) {
    res.statusCode = 404
  }

  // A unique request timestamp used by development to ensure that it's
  // consistent and won't change during this request. This is important to
  // avoid that resources can be deduped by React Float if the same resource is
  // rendered or preloaded multiple times: `<link href="a.css?v={Date.now()}"/>`.
  const requestTimestamp = Date.now()

  const {
    serverActionsManifest,
    ComponentMod,
    nextFontManifest,
    serverActions,
    assetPrefix = '',
    enableTainting,
  } = renderOpts

  // We need to expose the bundled `require` API globally for
  // react-server-dom-webpack. This is a hack until we find a better way.
  if (ComponentMod.__next_app__) {
    const instrumented = wrapClientComponentLoader(ComponentMod)
    // @ts-ignore
    globalThis.__next_require__ = instrumented.require
    // When we are prerendering if there is a cacheSignal for tracking
    // cache reads we wrap the loadChunk in this tracking. This allows us
    // to treat chunk loading with similar semantics as cache reads to avoid
    // async loading chunks from causing a prerender to abort too early.
    // @ts-ignore
    globalThis.__next_chunk_load__ = (...args: Array<any>) => {
      const loadingChunk = instrumented.loadChunk(...args)
      trackChunkLoading(loadingChunk)
      return loadingChunk
    }
  }

  if (process.env.NODE_ENV === 'development') {
    // reset isr status at start of request
    const { pathname } = new URL(req.url || '/', 'http://n')
    renderOpts.setAppIsrStatus?.(pathname, null)
  }

  if (
    // The type check here ensures that `req` is correctly typed, and the
    // environment variable check provides dead code elimination.
    process.env.NEXT_RUNTIME !== 'edge' &&
    isNodeNextRequest(req)
  ) {
    req.originalRequest.on('end', () => {
      const staticGenStore =
        ComponentMod.staticGenerationAsyncStorage.getStore()
      const prerenderStore = prerenderAsyncStorage.getStore()
      const isPPR = !!prerenderStore?.dynamicTracking?.dynamicAccesses?.length

      if (
        process.env.NODE_ENV === 'development' &&
        staticGenStore &&
        renderOpts.setAppIsrStatus &&
        !isPPR
      ) {
        // only node can be ISR so we only need to update the status here
        const { pathname } = new URL(req.url || '/', 'http://n')
        let { revalidate } = staticGenStore
        if (typeof revalidate === 'undefined') {
          revalidate = false
        }
        if (revalidate === false || revalidate > 0) {
          renderOpts.setAppIsrStatus(pathname, revalidate)
        }
      }

      requestEndedState.ended = true

      if ('performance' in globalThis) {
        const metrics = getClientComponentLoaderMetrics({ reset: true })
        if (metrics) {
          getTracer()
            .startSpan(NextNodeServerSpan.clientComponentLoading, {
              startTime: metrics.clientComponentLoadStart,
              attributes: {
                'next.clientComponentLoadCount':
                  metrics.clientComponentLoadCount,
              },
            })
            .end(
              metrics.clientComponentLoadStart +
                metrics.clientComponentLoadTimes
            )
        }
      }
    })
  }

  const metadata: AppPageRenderResultMetadata = {}

  const appUsingSizeAdjustment = !!nextFontManifest?.appUsingSizeAdjust

  // TODO: fix this typescript
  const clientReferenceManifest = renderOpts.clientReferenceManifest!

  const serverModuleMap = createServerModuleMap({
    serverActionsManifest,
    pageName: renderOpts.page,
  })

  setReferenceManifestsSingleton({
    clientReferenceManifest,
    serverActionsManifest,
    serverModuleMap,
  })

  ComponentMod.patchFetch()

  // Pull out the hooks/references from the component.
  const { tree: loaderTree, taintObjectReference } = ComponentMod

  if (enableTainting) {
    taintObjectReference(
      'Do not pass process.env to client components since it will leak sensitive data',
      process.env
    )
  }

  staticGenerationStore.fetchMetrics = []
  metadata.fetchMetrics = staticGenerationStore.fetchMetrics

  // don't modify original query object
  query = { ...query }
  stripInternalQueries(query)

  const { flightRouterState, isPrefetchRequest, isRSCRequest, nonce } =
    parsedRequestHeaders

  /**
   * The metadata items array created in next-app-loader with all relevant information
   * that we need to resolve the final metadata.
   */
  let requestId: string

  if (process.env.NEXT_RUNTIME === 'edge') {
    requestId = crypto.randomUUID()
  } else {
    requestId = require('next/dist/compiled/nanoid').nanoid()
  }

  /**
   * Dynamic parameters. E.g. when you visit `/dashboard/vercel` which is rendered by `/dashboard/[slug]` the value will be {"slug": "vercel"}.
   */
  const params = renderOpts.params ?? {}

  const { isStaticGeneration, fallbackRouteParams } = staticGenerationStore

  const getDynamicParamFromSegment = makeGetDynamicParamFromSegment(
    params,
    pagePath,
    fallbackRouteParams
  )

  const isActionRequest = getServerActionRequestMetadata(req).isServerAction

  const ctx: AppRenderContext = {
    componentMod: ComponentMod,
    renderOpts,
    requestStore,
    staticGenerationStore,
    parsedRequestHeaders,
    getDynamicParamFromSegment,
    query,
    isPrefetch: isPrefetchRequest,
    isAction: isActionRequest,
    requestTimestamp,
    appUsingSizeAdjustment,
    flightRouterState,
    requestId,
    defaultRevalidate: false,
    pagePath,
    clientReferenceManifest,
    assetPrefix,
    isNotFoundPath,
    nonce,
    res,
  }

  getTracer().getRootSpanAttributes()?.set('next.route', pagePath)

  if (isStaticGeneration) {
    // We're either building or revalidating. In either case we need to
    // prerender our page rather than render it.
    const prerenderToStreamWithTracing = getTracer().wrap(
      AppRenderSpan.getBodyResult,
      {
        spanName: `prerender route (app) ${pagePath}`,
        attributes: {
          'next.route': pagePath,
        },
      },
      prerenderToStream
    )

    let response = await prerenderToStreamWithTracing(
      req,
      res,
      ctx,
      metadata,
      staticGenerationStore,
      loaderTree
    )

    // If we're debugging partial prerendering, print all the dynamic API accesses
    // that occurred during the render.
    // @TODO move into renderToStream function
    if (
      response.dynamicTracking &&
      accessedDynamicData(response.dynamicTracking) &&
      response.dynamicTracking.isDebugDynamicAccesses
    ) {
      warn('The following dynamic usage was detected:')
      for (const access of formatDynamicAPIAccesses(response.dynamicTracking)) {
        warn(access)
      }
    }

    // If we encountered any unexpected errors during build we fail the
    // prerendering phase and the build.
    if (response.digestErrorsMap.size) {
      const buildFailingError = response.digestErrorsMap.values().next().value
      if (buildFailingError) throw buildFailingError
    }
    // Pick first userland SSR error, which is also not a RSC error.
    if (response.ssrErrors.length) {
      const buildFailingError = response.ssrErrors.find((err) =>
        isUserLandError(err)
      )
      if (buildFailingError) throw buildFailingError
    }

    const options: RenderResultOptions = {
      metadata,
    }
    // If we have pending revalidates, wait until they are all resolved.
    if (staticGenerationStore.pendingRevalidates) {
      options.waitUntil = Promise.all([
        staticGenerationStore.incrementalCache?.revalidateTag(
          staticGenerationStore.revalidatedTags || []
        ),
        ...Object.values(staticGenerationStore.pendingRevalidates || {}),
      ])
    }

    addImplicitTags(staticGenerationStore, requestStore)

    if (staticGenerationStore.tags) {
      metadata.fetchTags = staticGenerationStore.tags.join(',')
    }

    // If force static is specifically set to false, we should not revalidate
    // the page.
    if (staticGenerationStore.forceStatic === false) {
      staticGenerationStore.revalidate = 0
    }

    // Copy the revalidation value onto the render result metadata.
    metadata.revalidate =
      staticGenerationStore.revalidate ?? ctx.defaultRevalidate

    // provide bailout info for debugging
    if (metadata.revalidate === 0) {
      metadata.staticBailoutInfo = {
        description: staticGenerationStore.dynamicUsageDescription,
        stack: staticGenerationStore.dynamicUsageStack,
      }
    }

    return new RenderResult(await streamToString(response.stream), options)
  } else {
    // We're rendering dynamically
    if (isRSCRequest) {
      return generateDynamicFlightRenderResult(req, ctx)
    }

    const renderToStreamWithTracing = getTracer().wrap(
      AppRenderSpan.getBodyResult,
      {
        spanName: `render route (app) ${pagePath}`,
        attributes: {
          'next.route': pagePath,
        },
      },
      renderToStream
    )

    let formState: null | any = null
    if (isActionRequest) {
      // For action requests, we handle them differently with a special render result.
      const actionRequestResult = await handleAction({
        req,
        res,
        ComponentMod,
        serverModuleMap,
        generateFlight: generateDynamicFlightRenderResult,
        staticGenerationStore,
        requestStore,
        serverActions,
        ctx,
      })

      if (actionRequestResult) {
        if (actionRequestResult.type === 'not-found') {
          const notFoundLoaderTree = createNotFoundLoaderTree(loaderTree)
          res.statusCode = 404
          const stream = await renderToStreamWithTracing(
            req,
            res,
            ctx,
            notFoundLoaderTree,
            formState,
            postponedState
          )

          return new RenderResult(stream, { metadata })
        } else if (actionRequestResult.type === 'done') {
          if (actionRequestResult.result) {
            actionRequestResult.result.assignMetadata(metadata)
            return actionRequestResult.result
          } else if (actionRequestResult.formState) {
            formState = actionRequestResult.formState
          }
        }
      }
    }

    const options: RenderResultOptions = {
      metadata,
    }

    const stream = await renderToStreamWithTracing(
      req,
      res,
      ctx,
      loaderTree,
      formState,
      postponedState
    )

    // If we have pending revalidates, wait until they are all resolved.
    if (staticGenerationStore.pendingRevalidates) {
      options.waitUntil = Promise.all([
        staticGenerationStore.incrementalCache?.revalidateTag(
          staticGenerationStore.revalidatedTags || []
        ),
        ...Object.values(staticGenerationStore.pendingRevalidates || {}),
      ])
    }

    addImplicitTags(staticGenerationStore, requestStore)

    if (staticGenerationStore.tags) {
      metadata.fetchTags = staticGenerationStore.tags.join(',')
    }

    // Create the new render result for the response.
    return new RenderResult(stream, options)
  }
}

export type AppPageRender = (
  req: BaseNextRequest,
  res: BaseNextResponse,
  pagePath: string,
  query: NextParsedUrlQuery,
  fallbackRouteParams: FallbackRouteParams | null,
  renderOpts: RenderOpts,
  serverComponentsHmrCache?: ServerComponentsHmrCache
) => Promise<RenderResult<AppPageRenderResultMetadata>>

export const renderToHTMLOrFlight: AppPageRender = (
  req,
  res,
  pagePath,
  query,
  fallbackRouteParams,
  renderOpts,
  serverComponentsHmrCache
) => {
  if (!req.url) {
    throw new Error('Invalid URL')
  }

  const url = parseRelativeUrl(req.url, undefined, false)

  // We read these values from the request object as, in certain cases,
  // base-server will strip them to opt into different rendering behavior.
  const parsedRequestHeaders = parseRequestHeaders(req.headers, {
    isRoutePPREnabled: renderOpts.experimental.isRoutePPREnabled === true,
  })

  const { isHmrRefresh } = parsedRequestHeaders

  const requestEndedState = { ended: false }
  let postponedState: PostponedState | null = null

  // If provided, the postpone state should be parsed so it can be provided to
  // React.
  if (typeof renderOpts.postponed === 'string') {
    if (fallbackRouteParams && fallbackRouteParams.size > 0) {
      throw new Error(
        'Invariant: postponed state should not be provided when fallback params are provided'
      )
    }

    postponedState = parsePostponedState(
      renderOpts.postponed,
      renderOpts.params
    )
  }

  return withRequestStore(
    renderOpts.ComponentMod.requestAsyncStorage,
    {
      req,
      url,
      res,
      renderOpts,
      isHmrRefresh,
      serverComponentsHmrCache,
    },
    (requestStore) =>
      withStaticGenerationStore(
        renderOpts.ComponentMod.staticGenerationAsyncStorage,
        {
          page: renderOpts.routeModule.definition.page,
          fallbackRouteParams,
          renderOpts,
          requestEndedState,
        },
        (staticGenerationStore) =>
          renderToHTMLOrFlightImpl(
            req,
            res,
            pagePath,
            query,
            renderOpts,
            requestStore,
            staticGenerationStore,
            parsedRequestHeaders,
            requestEndedState,
            postponedState
          )
      )
  )
}

async function renderToStream(
  req: BaseNextRequest,
  res: BaseNextResponse,
  ctx: AppRenderContext,
  tree: LoaderTree,
  formState: any,
  postponedState: PostponedState | null
): Promise<ReadableStream<Uint8Array>> {
  const renderOpts = ctx.renderOpts
  const ComponentMod = renderOpts.ComponentMod
  // TODO: fix this typescript
  const clientReferenceManifest = renderOpts.clientReferenceManifest!

  const { ServerInsertedHTMLProvider, renderServerInsertedHTML } =
    createServerInsertedHTML()

  const tracingMetadata = getTracedMetadata(
    getTracer().getTracePropagationData(),
    renderOpts.experimental.clientTraceMetadata
  )

  const polyfills: JSX.IntrinsicElements['script'][] =
    renderOpts.buildManifest.polyfillFiles
      .filter(
        (polyfill) =>
          polyfill.endsWith('.js') && !polyfill.endsWith('.module.js')
      )
      .map((polyfill) => ({
        src: `${ctx.assetPrefix}/_next/${polyfill}${getAssetQueryString(
          ctx,
          false
        )}`,
        integrity: renderOpts.subresourceIntegrityManifest?.[polyfill],
        crossOrigin: renderOpts.crossOrigin,
        noModule: true,
        nonce: ctx.nonce,
      }))

  const [preinitScripts, bootstrapScript] = getRequiredScripts(
    renderOpts.buildManifest,
    // Why is assetPrefix optional on renderOpts?
    // @TODO make it default empty string on renderOpts and get rid of it from ctx
    ctx.assetPrefix,
    renderOpts.crossOrigin,
    renderOpts.subresourceIntegrityManifest,
    getAssetQueryString(ctx, true),
    ctx.nonce,
    renderOpts.page
  )

  const reactServerErrorsByDigest: Map<string, DigestedError> = new Map()
  const silenceLogger = false
  function onHTMLRenderRSCError(err: DigestedError) {
    return renderOpts.onInstrumentationRequestError?.(
      err,
      req,
      createErrorContext(ctx, 'react-server-components')
    )
  }
  const serverComponentsErrorHandler = createHTMLReactServerErrorHandler(
    !!renderOpts.dev,
    !!renderOpts.nextExport,
    reactServerErrorsByDigest,
    silenceLogger,
    onHTMLRenderRSCError
  )

  function onHTMLRenderSSRError(err: DigestedError) {
    return renderOpts.onInstrumentationRequestError?.(
      err,
      req,
      createErrorContext(ctx, 'server-rendering')
    )
  }

  const allCapturedErrors: Array<unknown> = []
  const htmlRendererErrorHandler = createHTMLErrorHandler(
    !!renderOpts.dev,
    !!renderOpts.nextExport,
    reactServerErrorsByDigest,
    allCapturedErrors,
    silenceLogger,
    onHTMLRenderSSRError
  )

  let reactServerResult: null | ReactServerResult = null

  const setHeader = res.setHeader.bind(res)

  try {
    // This is a dynamic render. We don't do dynamic tracking because we're not prerendering
    const RSCPayload = await getRSCPayload(tree, ctx, res.statusCode === 404)
    reactServerResult = new ReactServerResult(
      ComponentMod.renderToReadableStream(
        RSCPayload,
        clientReferenceManifest.clientModules,
        {
          onError: serverComponentsErrorHandler,
          nonce: ctx.nonce,
        }
      )
    )

    // React doesn't start rendering synchronously but we want the RSC render to have a chance to start
    // before we begin SSR rendering because we want to capture any available preload headers so we tick
    // one task before continuing
    await waitAtLeastOneReactRenderTask()

    // If provided, the postpone state should be parsed as JSON so it can be
    // provided to React.
    if (typeof renderOpts.postponed === 'string') {
      if (postponedState?.type === DynamicState.DATA) {
        // We have a complete HTML Document in the prerender but we need to
        // still include the new server component render because it was not included
        // in the static prelude.
        const inlinedReactServerDataStream = createInlinedDataReadableStream(
          reactServerResult.tee(),
          ctx.nonce,
          formState
        )

        return chainStreams(
          inlinedReactServerDataStream,
          createDocumentClosingStream()
        )
      } else if (postponedState) {
        // We assume we have dynamic HTML requiring a resume render to complete
        const postponed = getPostponedFromState(postponedState)

        const resume = require('react-dom/server.edge')
          .resume as (typeof import('react-dom/server.edge'))['resume']

        const htmlStream = await resume(
          <App
            reactServerStream={reactServerResult.tee()}
            preinitScripts={preinitScripts}
            clientReferenceManifest={clientReferenceManifest}
            ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
            nonce={ctx.nonce}
          />,
          postponed,
          {
            onError: htmlRendererErrorHandler,
            nonce: ctx.nonce,
          }
        )

        const getServerInsertedHTML = makeGetServerInsertedHTML({
          polyfills,
          renderServerInsertedHTML,
          serverCapturedErrors: allCapturedErrors,
          basePath: renderOpts.basePath,
          tracingMetadata: tracingMetadata,
        })
        return await continueDynamicHTMLResume(htmlStream, {
          inlinedDataStream: createInlinedDataReadableStream(
            reactServerResult.consume(),
            ctx.nonce,
            formState
          ),
          getServerInsertedHTML,
        })
      }
    }

    // This is a regular dynamic render
    const renderToReadableStream = require('react-dom/server.edge')
      .renderToReadableStream as (typeof import('react-dom/server.edge'))['renderToReadableStream']

    const htmlStream = await renderToReadableStream(
      <App
        reactServerStream={reactServerResult.tee()}
        preinitScripts={preinitScripts}
        clientReferenceManifest={clientReferenceManifest}
        ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
        nonce={ctx.nonce}
      />,
      {
        onError: htmlRendererErrorHandler,
        nonce: ctx.nonce,
        onHeaders: (headers: Headers) => {
          headers.forEach((value, key) => {
            setHeader(key, value)
          })
        },
        maxHeadersLength: renderOpts.reactMaxHeadersLength,
        // When debugging the static shell, client-side rendering should be
        // disabled to prevent blanking out the page.
        bootstrapScripts: renderOpts.isDebugStaticShell
          ? []
          : [bootstrapScript],
        formState,
      }
    )

    const getServerInsertedHTML = makeGetServerInsertedHTML({
      polyfills,
      renderServerInsertedHTML,
      serverCapturedErrors: allCapturedErrors,
      basePath: renderOpts.basePath,
      tracingMetadata: tracingMetadata,
    })
    /**
     * Rules of Static & Dynamic HTML:
     *
     *    1.) We must generate static HTML unless the caller explicitly opts
     *        in to dynamic HTML support.
     *
     *    2.) If dynamic HTML support is requested, we must honor that request
     *        or throw an error. It is the sole responsibility of the caller to
     *        ensure they aren't e.g. requesting dynamic HTML for an AMP page.
     *
     * These rules help ensure that other existing features like request caching,
     * coalescing, and ISR continue working as intended.
     */
    const generateStaticHTML = renderOpts.supportsDynamicResponse !== true
    const validateRootLayout = renderOpts.dev
    return await continueFizzStream(htmlStream, {
      inlinedDataStream: createInlinedDataReadableStream(
        reactServerResult.consume(),
        ctx.nonce,
        formState
      ),
      isStaticGeneration: generateStaticHTML,
      getServerInsertedHTML,
      serverInsertedHTMLToHead: true,
      validateRootLayout,
    })
  } catch (err) {
    if (
      isStaticGenBailoutError(err) ||
      (typeof err === 'object' &&
        err !== null &&
        'message' in err &&
        typeof err.message === 'string' &&
        err.message.includes(
          'https://nextjs.org/docs/advanced-features/static-html-export'
        ))
    ) {
      // Ensure that "next dev" prints the red error overlay
      throw err
    }

    // If a bailout made it to this point, it means it wasn't wrapped inside
    // a suspense boundary.
    const shouldBailoutToCSR = isBailoutToCSRError(err)
    if (shouldBailoutToCSR) {
      const stack = getStackWithoutErrorMessage(err)
      error(
        `${err.reason} should be wrapped in a suspense boundary at page "${ctx.pagePath}". Read more: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout\n${stack}`
      )

      throw err
    }

    if (isNotFoundError(err)) {
      res.statusCode = 404
    }
    let hasRedirectError = false
    if (isRedirectError(err)) {
      hasRedirectError = true
      res.statusCode = getRedirectStatusCodeFromError(err)
      if (err.mutableCookies) {
        const headers = new Headers()

        // If there were mutable cookies set, we need to set them on the
        // response.
        if (appendMutableCookies(headers, err.mutableCookies)) {
          setHeader('set-cookie', Array.from(headers.values()))
        }
      }
      const redirectUrl = addPathPrefix(
        getURLFromRedirectError(err),
        renderOpts.basePath
      )
      setHeader('Location', redirectUrl)
    }

    const is404 = res.statusCode === 404
    if (!is404 && !hasRedirectError && !shouldBailoutToCSR) {
      res.statusCode = 500
    }

    const errorType = is404
      ? 'not-found'
      : hasRedirectError
        ? 'redirect'
        : undefined

    const [errorPreinitScripts, errorBootstrapScript] = getRequiredScripts(
      renderOpts.buildManifest,
      ctx.assetPrefix,
      renderOpts.crossOrigin,
      renderOpts.subresourceIntegrityManifest,
      getAssetQueryString(ctx, false),
      ctx.nonce,
      '/_not-found/page'
    )

    const errorRSCPayload = await getErrorRSCPayload(tree, ctx, errorType)

    const errorServerStream = ComponentMod.renderToReadableStream(
      errorRSCPayload,
      clientReferenceManifest.clientModules,
      {
        onError: serverComponentsErrorHandler,
        nonce: ctx.nonce,
      }
    )

    if (reactServerResult === null) {
      // We errored when we did not have an RSC stream to read from. This is not just a render
      // error, we need to throw early
      throw err
    }

    try {
      const fizzStream = await renderToInitialFizzStream({
        ReactDOMServer: require('react-dom/server.edge'),
        element: (
          <AppWithoutContext
            reactServerStream={errorServerStream}
            preinitScripts={errorPreinitScripts}
            clientReferenceManifest={clientReferenceManifest}
            nonce={ctx.nonce}
          />
        ),
        streamOptions: {
          nonce: ctx.nonce,
          // Include hydration scripts in the HTML
          bootstrapScripts: [errorBootstrapScript],
          formState,
        },
      })

      /**
       * Rules of Static & Dynamic HTML:
       *
       *    1.) We must generate static HTML unless the caller explicitly opts
       *        in to dynamic HTML support.
       *
       *    2.) If dynamic HTML support is requested, we must honor that request
       *        or throw an error. It is the sole responsibility of the caller to
       *        ensure they aren't e.g. requesting dynamic HTML for an AMP page.
       *
       * These rules help ensure that other existing features like request caching,
       * coalescing, and ISR continue working as intended.
       */
      const generateStaticHTML = renderOpts.supportsDynamicResponse !== true
      const validateRootLayout = renderOpts.dev
      return await continueFizzStream(fizzStream, {
        inlinedDataStream: createInlinedDataReadableStream(
          // This is intentionally using the readable datastream from the
          // main render rather than the flight data from the error page
          // render
          reactServerResult.consume(),
          ctx.nonce,
          formState
        ),
        isStaticGeneration: generateStaticHTML,
        getServerInsertedHTML: makeGetServerInsertedHTML({
          polyfills,
          renderServerInsertedHTML,
          serverCapturedErrors: [],
          basePath: renderOpts.basePath,
          tracingMetadata: tracingMetadata,
        }),
        serverInsertedHTMLToHead: true,
        validateRootLayout,
      })
    } catch (finalErr: any) {
      if (process.env.NODE_ENV === 'development' && isNotFoundError(finalErr)) {
        const bailOnNotFound: typeof import('../../client/components/dev-root-not-found-boundary').bailOnNotFound =
          require('../../client/components/dev-root-not-found-boundary').bailOnNotFound
        bailOnNotFound()
      }
      throw finalErr
    }
  }
}

type PrerenderToStreamResult = {
  stream: ReadableStream<Uint8Array>
  digestErrorsMap: Map<string, DigestedError>
  ssrErrors: Array<unknown>
  dynamicTracking?: null | DynamicTrackingState
}

/**
 * Determines whether we should generate static flight data.
 */
function shouldGenerateStaticFlightData(
  staticGenerationStore: StaticGenerationStore
): boolean {
  const { fallbackRouteParams, isStaticGeneration } = staticGenerationStore
  if (!isStaticGeneration) return false

  if (fallbackRouteParams && fallbackRouteParams.size > 0) {
    return false
  }

  return true
}

async function prerenderToStream(
  req: BaseNextRequest,
  res: BaseNextResponse,
  ctx: AppRenderContext,
  metadata: AppPageRenderResultMetadata,
  staticGenerationStore: StaticGenerationStore,
  tree: LoaderTree
): Promise<PrerenderToStreamResult> {
  // When prerendering formState is always null. We still include it
  // because some shared APIs expect a formState value and this is slightly
  // more explicit than making it an optional function argument
  const formState = null

  const renderOpts = ctx.renderOpts
  const ComponentMod = renderOpts.ComponentMod
  // TODO: fix this typescript
  const clientReferenceManifest = renderOpts.clientReferenceManifest!
  const fallbackRouteParams = staticGenerationStore.fallbackRouteParams

  const { ServerInsertedHTMLProvider, renderServerInsertedHTML } =
    createServerInsertedHTML()

  const tracingMetadata = getTracedMetadata(
    getTracer().getTracePropagationData(),
    renderOpts.experimental.clientTraceMetadata
  )

  const polyfills: JSX.IntrinsicElements['script'][] =
    renderOpts.buildManifest.polyfillFiles
      .filter(
        (polyfill) =>
          polyfill.endsWith('.js') && !polyfill.endsWith('.module.js')
      )
      .map((polyfill) => ({
        src: `${ctx.assetPrefix}/_next/${polyfill}${getAssetQueryString(
          ctx,
          false
        )}`,
        integrity: renderOpts.subresourceIntegrityManifest?.[polyfill],
        crossOrigin: renderOpts.crossOrigin,
        noModule: true,
        nonce: ctx.nonce,
      }))

  const [preinitScripts, bootstrapScript] = getRequiredScripts(
    renderOpts.buildManifest,
    // Why is assetPrefix optional on renderOpts?
    // @TODO make it default empty string on renderOpts and get rid of it from ctx
    ctx.assetPrefix,
    renderOpts.crossOrigin,
    renderOpts.subresourceIntegrityManifest,
    getAssetQueryString(ctx, true),
    ctx.nonce,
    renderOpts.page
  )

  const reactServerErrorsByDigest: Map<string, DigestedError> = new Map()
  // We don't report errors during prerendering through our instrumentation hooks
  const silenceLogger = !!renderOpts.experimental.isRoutePPREnabled
  function onHTMLRenderRSCError(err: DigestedError) {
    return renderOpts.onInstrumentationRequestError?.(
      err,
      req,
      createErrorContext(ctx, 'react-server-components')
    )
  }
  const serverComponentsErrorHandler = createHTMLReactServerErrorHandler(
    !!renderOpts.dev,
    !!renderOpts.nextExport,
    reactServerErrorsByDigest,
    silenceLogger,
    onHTMLRenderRSCError
  )

  function onHTMLRenderSSRError(err: DigestedError) {
    return renderOpts.onInstrumentationRequestError?.(
      err,
      req,
      createErrorContext(ctx, 'server-rendering')
    )
  }
  const allCapturedErrors: Array<unknown> = []
  const htmlRendererErrorHandler = createHTMLErrorHandler(
    !!renderOpts.dev,
    !!renderOpts.nextExport,
    reactServerErrorsByDigest,
    allCapturedErrors,
    silenceLogger,
    onHTMLRenderSSRError
  )

  let dynamicTracking: null | DynamicTrackingState = null
  let reactServerPrerenderResult: null | ReactServerPrerenderResult = null
  const setHeader = (name: string, value: string | string[]) => {
    res.setHeader(name, value)

    metadata.headers ??= {}
    metadata.headers[name] = res.getHeader(name)

    return res
  }

  try {
    if (renderOpts.experimental.dynamicIO) {
      if (renderOpts.experimental.isRoutePPREnabled) {
        /**
         * dynamicIO with PPR
         *
         * The general approach is to render the RSC stream first allowing any cache reads to resolve.
         * Once we have settled all cache reads we restart the render and abort after a single Task.
         *
         * Unlike with the non PPR case we can't synchronously abort the render when a dynamic API is used
         * during the initial render because we need to ensure all caches can be filled as part of the initial Task
         * and a synchronous abort might prevent us from filling all caches.
         *
         * Once the render is complete we allow the SSR render to finish and use a combination of the postponed state
         * and the reactServerIsDynamic value to determine how to treat the resulting render
         */

        const PRERENDER_COMPLETE = 'NEXT_PRERENDER_COMPLETE'
        const abortReason = new Error(PRERENDER_COMPLETE)

        const cacheSignal = new CacheSignal()
        const prospectiveRenderPrerenderStore: PrerenderStore = {
          cacheSignal,
          // During the prospective render we don't want to synchronously abort on dynamic access
          // because it could prevent us from discovering all caches in siblings. So we omit the controller
          // from the prerender store this time.
          controller: null,
          // With PPR during Prerender we don't need to track individual dynamic reasons
          // because we will always do a final render after caches have filled and we
          // will track it again there
          dynamicTracking: null,
        }

        let flightController = new AbortController()
        // We're not going to use the result of this render because the only time it could be used
        // is if it completes in a microtask and that's likely very rare for any non-trivial app
        const firstAttemptRSCPayload = await getRSCPayload(
          tree,
          ctx,
          res.statusCode === 404
        )
        function voidOnError() {}
        ;(
          prerenderAsyncStorage.run(
            // The store to scope
            prospectiveRenderPrerenderStore,
            // The function to run
            ComponentMod.prerender,
            // ... the arguments for the function to run
            firstAttemptRSCPayload,
            clientReferenceManifest.clientModules,
            {
              nonce: ctx.nonce,
              // This render will be thrown away so we don't need to track errors or postpones
              onError: voidOnError,
              onPostpone: undefined,
              // we don't care to track postpones during the prospective render because we need
              // to always do a final render anyway
              signal: flightController.signal,
            }
          ) as Promise<ReactServerPrerenderResolveToType>
        ).catch(() => {})

        // When this resolves the cache has no inflight reads and we can ascertain the dynamic outcome
        await cacheSignal.cacheReady()
        flightController.abort(abortReason)
        // When PPR is enabled we don't synchronously abort the render when performing a prospective render
        // because it might prevent us from discovering all caches during the render which is essential
        // when we perform the second single-task render.

        // Reset the dynamic IO state for the final render
        flightController = new AbortController()
        dynamicTracking = createDynamicTrackingState(
          renderOpts.isDebugDynamicAccesses
        )

        const finalRenderPrerenderStore: PrerenderStore = {
          // During the final prerender we don't need to track cache access so we omit the signal
          cacheSignal: null,
          // During the final render we do want to abort synchronously on dynamic access so we
          // include the flight controller in the store.
          controller: flightController,
          dynamicTracking,
        }

        let reactServerIsDynamic = false
        function onError(err: unknown, errorInfo: ErrorInfo) {
          if (err === abortReason || isPrerenderInterruptedError(err)) {
            reactServerIsDynamic = true
            return
          }

          return serverComponentsErrorHandler(err, errorInfo)
        }

        function onPostpone(reason: string) {
          if (
            reason === PRERENDER_COMPLETE ||
            isRenderInterruptedReason(reason)
          ) {
            reactServerIsDynamic = true
          }
        }
        const finalAttemptRSCPayload = await getRSCPayload(
          tree,
          ctx,
          res.statusCode === 404
        )
        const reactServerResult = (reactServerPrerenderResult =
          await createReactServerPrerenderResult(
            prerenderAndAbortInSequentialTasks(
              () =>
                prerenderAsyncStorage.run(
                  // The store to scope
                  finalRenderPrerenderStore,
                  // The function to run
                  ComponentMod.prerender,
                  // ... the arguments for the function to run
                  finalAttemptRSCPayload,
                  clientReferenceManifest.clientModules,
                  {
                    nonce: ctx.nonce,
                    onError,
                    onPostpone,
                    signal: flightController.signal,
                  }
                ),
              () => {
                flightController.abort(abortReason)
              }
            )
          ))

        await warmFlightResponse(
          reactServerResult.asStream(),
          clientReferenceManifest
        )

        const SSRController = new AbortController()
        const ssrPrerenderStore: PrerenderStore = {
          // For HTML Generation we don't need to track cache reads (RSC only)
          cacheSignal: null,
          // We expect the SSR render to complete in a single Task and need to be able to synchronously abort
          // When you use APIs that are considered dynamic or synchronous IO.
          controller: SSRController,
          // We do track dynamic access because searchParams and certain hooks can still be
          // dynamic during SSR
          dynamicTracking,
        }
        let SSRIsDynamic = false
        function SSROnError(err: unknown, errorInfo: unknown) {
          if (err === abortReason || isPrerenderInterruptedError(err)) {
            SSRIsDynamic = true
            return
          }

          return htmlRendererErrorHandler(err, errorInfo)
        }

        function SSROnPostpone(reason: string) {
          if (
            reason === PRERENDER_COMPLETE ||
            isRenderInterruptedReason(reason)
          ) {
            SSRIsDynamic = true
          }
        }

        const prerender = require('react-dom/static.edge')
          .prerender as (typeof import('react-dom/static.edge'))['prerender']
        const { prelude, postponed } = await prerenderAndAbortInSequentialTasks(
          () =>
            prerenderAsyncStorage.run(
              ssrPrerenderStore,
              prerender,
              <App
                reactServerStream={reactServerResult.asUnclosingStream()}
                preinitScripts={preinitScripts}
                clientReferenceManifest={clientReferenceManifest}
                ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
                nonce={ctx.nonce}
              />,
              {
                signal: SSRController.signal,
                onError: SSROnError,
                onPostpone: SSROnPostpone,
                onHeaders: (headers: Headers) => {
                  headers.forEach((value, key) => {
                    setHeader(key, value)
                  })
                },
                maxHeadersLength: renderOpts.reactMaxHeadersLength,
                // When debugging the static shell, client-side rendering should be
                // disabled to prevent blanking out the page.
                bootstrapScripts: renderOpts.isDebugStaticShell
                  ? []
                  : [bootstrapScript],
              }
            ),
          () => {
            SSRController.abort(abortReason)
          }
        )

        const getServerInsertedHTML = makeGetServerInsertedHTML({
          polyfills,
          renderServerInsertedHTML,
          serverCapturedErrors: allCapturedErrors,
          basePath: renderOpts.basePath,
          tracingMetadata: tracingMetadata,
        })

        metadata.flightData = await streamToBuffer(reactServerResult.asStream())

        if (SSRIsDynamic || reactServerIsDynamic) {
          if (postponed != null) {
            // Dynamic HTML case
            metadata.postponed = getDynamicHTMLPostponedState(
              postponed,
              fallbackRouteParams
            )
          } else {
            // Dynamic Data case
            metadata.postponed = getDynamicDataPostponedState()
          }
          reactServerResult.consume()
          return {
            digestErrorsMap: reactServerErrorsByDigest,
            ssrErrors: allCapturedErrors,
            stream: await continueDynamicPrerender(prelude, {
              getServerInsertedHTML,
            }),
            dynamicTracking,
          }
        } else {
          // Static case
          if (staticGenerationStore.forceDynamic) {
            throw new StaticGenBailoutError(
              'Invariant: a Page with `dynamic = "force-dynamic"` did not trigger the dynamic pathway. This is a bug in Next.js'
            )
          }

          let htmlStream = prelude
          if (postponed != null) {
            // We postponed but nothing dynamic was used. We resume the render now and immediately abort it
            // so we can set all the postponed boundaries to client render mode before we store the HTML response
            const resume = require('react-dom/server.edge')
              .resume as (typeof import('react-dom/server.edge'))['resume']

            // We don't actually want to render anything so we just pass a stream
            // that never resolves. The resume call is going to abort immediately anyway
            const foreverStream = new ReadableStream<Uint8Array>()

            const resumeStream = await resume(
              <App
                reactServerStream={foreverStream}
                preinitScripts={() => {}}
                clientReferenceManifest={clientReferenceManifest}
                ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
                nonce={ctx.nonce}
              />,
              JSON.parse(JSON.stringify(postponed)),
              {
                signal: createPostponedAbortSignal('static prerender resume'),
                onError: htmlRendererErrorHandler,
                nonce: ctx.nonce,
              }
            )

            // First we write everything from the prerender, then we write everything from the aborted resume render
            htmlStream = chainStreams(prelude, resumeStream)
          }

          return {
            digestErrorsMap: reactServerErrorsByDigest,
            ssrErrors: allCapturedErrors,
            stream: await continueStaticPrerender(htmlStream, {
              inlinedDataStream: createInlinedDataReadableStream(
                reactServerResult.consumeAsStream(),
                ctx.nonce,
                formState
              ),
              getServerInsertedHTML,
            }),
            dynamicTracking,
          }
        }
      } else {
        /**
         * dynamicIO without PPR
         *
         * The general approach is to render the RSC tree first allowing for any inflight
         * caches to resolve. Once we have settled inflight caches we can check and see if any
         * synchronous dynamic APIs were used. If so we don't need to bother doing anything more
         * because the page will be dynamic on re-render anyway
         *
         * If no sync dynamic APIs were used we then re-render and abort after a single Task.
         * If the render errors we know that the page has some dynamic IO. This assumes and relies
         * upon caches reading from a in process memory cache and resolving in a microtask. While this
         * is true from our own default cache implementation and if you don't exceed our LRU size it
         * might not be true for custom cache implementations.
         *
         * Future implementations can do some different strategies during build like using IPC to
         * synchronously fill caches during this special rendering mode. For now this heuristic should work
         */

        const cache = staticGenerationStore.incrementalCache
        if (!cache) {
          throw new Error(
            'Expected incremental cache to exist. This is a bug in Next.js'
          )
        }

        const PRERENDER_COMPLETE = 'NEXT_PRERENDER_COMPLETE'
        const abortReason = new Error(PRERENDER_COMPLETE)

        // We need to scope the dynamic IO state per render because we don't want to leak
        // details between the prospective render and the final render
        let flightController = new AbortController()

        let reactServerIsDynamic = false
        function onError(err: unknown, errorInfo: ErrorInfo) {
          if (err === abortReason || isPrerenderInterruptedError(err)) {
            reactServerIsDynamic = true
            return
          }

          return serverComponentsErrorHandler(err, errorInfo)
        }

        dynamicTracking = createDynamicTrackingState(
          renderOpts.isDebugDynamicAccesses
        )

        const cacheSignal = new CacheSignal()
        const prospectiveRenderPrerenderStore: PrerenderStore = {
          cacheSignal,
          // When PPR is off we can synchronously abort the prospective render because we will
          // always hit this path on the final render and thus we can skip the final render and just
          // consider the route dynamic.
          controller: flightController,
          dynamicTracking,
        }

        const firstAttemptRSCPayload = await getRSCPayload(
          tree,
          ctx,
          res.statusCode === 404
        )
        // We're not going to use the result of this render because the only time it could be used
        // is if it completes in a microtask and that's likely very rare for any non-trivial app
        ;(
          prerenderAsyncStorage.run(
            // The store to scope
            prospectiveRenderPrerenderStore,
            // The function to run
            ComponentMod.prerender,
            // ... the arguments for the function to run
            firstAttemptRSCPayload,
            clientReferenceManifest.clientModules,
            {
              nonce: ctx.nonce,
              onError,
              signal: flightController.signal,
            }
          ) as Promise<ReactServerPrerenderResolveToType>
        ).catch(() => {})

        // When this resolves the cache has no inflight reads and we can ascertain the dynamic outcome
        await cacheSignal.cacheReady()
        if (reactServerIsDynamic) {
          // During a prospective render the only dynamic thing that can happen is a synchronous dynamic
          // API access. We expect to have a tracked expression to use for our dynamic error but we fall back
          // to a generic error if we don't.
          const dynamicReason = getFirstDynamicReason(dynamicTracking)
          if (dynamicReason) {
            throw new DynamicServerError(
              `Route ${staticGenerationStore.route} couldn't be rendered statically because it used \`${dynamicReason}\`. See more info here: https://nextjs.org/docs/messages/dynamic-server-error`
            )
          } else {
            console.error(
              'Expected Next.js to keep track of reason for opting out of static rendering but one was not found. This is a bug in Next.js'
            )
            throw new DynamicServerError(
              `Route ${staticGenerationStore.route} couldn't be rendered statically because it used a dynamic API. See more info here: https://nextjs.org/docs/messages/dynamic-server-error`
            )
          }
        } else {
          // The render didn't explicitly use any Dynamic APIs but it might have IO so we need to retry
          // the render. We abort the current render here to avoid doing unecessary work.
          // Keep in mind that while the render is aborted, inflight async ServerComponents can still continue
          // and might call dynamic APIs.
          flightController.abort(abortReason)
        }

        // Reset the prerenderState because we are going to retry the render
        flightController = new AbortController()
        dynamicTracking = createDynamicTrackingState(
          renderOpts.isDebugDynamicAccesses
        )
        reactServerIsDynamic = false

        const finalRenderPrerenderStore: PrerenderStore = {
          // During the final prerender we don't need to track cache access so we omit the signal
          cacheSignal: null,
          controller: flightController,
          dynamicTracking,
        }

        const finalAttemptRSCPayload = await getRSCPayload(
          tree,
          ctx,
          res.statusCode === 404
        )

        const reactServerResult = (reactServerPrerenderResult =
          await createReactServerPrerenderResult(
            prerenderAndAbortInSequentialTasks(
              () =>
                prerenderAsyncStorage.run(
                  // The store to scope
                  finalRenderPrerenderStore,
                  // The function to run
                  ComponentMod.prerender,
                  // ... the arguments for the function to run
                  finalAttemptRSCPayload,
                  clientReferenceManifest.clientModules,
                  {
                    nonce: ctx.nonce,
                    onError,
                    signal: flightController.signal,
                  }
                ),
              () => {
                flightController.abort(abortReason)
              }
            )
          ))

        if (reactServerIsDynamic) {
          // There was unfinished work after we aborted after the first render Task. This means there is some IO
          // that is not covered by a cache and we need to bail out of static generation.
          const err = new DynamicServerError(
            `Route ${staticGenerationStore.route} couldn't be rendered statically because it used IO that was not cached in a Server Component. See more info here: https://nextjs.org/docs/messages/dynamic-io`
          )
          serverComponentsErrorHandler(err, {})
          throw err
        }

        await warmFlightResponse(
          reactServerResult.asStream(),
          clientReferenceManifest
        )

        const SSRController = new AbortController()
        const ssrPrerenderStore: PrerenderStore = {
          // For HTML Generation we don't need to track cache reads (RSC only)
          cacheSignal: null,
          // We expect the SSR render to complete in a single Task and need to be able to synchronously abort
          // When you use APIs that are considered dynamic or synchronous IO.
          controller: SSRController,
          // We do track dynamic access because searchParams and certain hooks can still be
          // dynamic during SSR
          dynamicTracking,
        }
        let SSRIsDynamic = false
        function SSROnError(err: unknown, errorInfo: unknown) {
          if (err === abortReason || isPrerenderInterruptedError(err)) {
            SSRIsDynamic = true
            return
          }

          return htmlRendererErrorHandler(err, errorInfo)
        }
        function SSROnPostpone(_: string) {
          // We don't really support postponing when PPR is off but since experimental react
          // has this API enabled we need to account for it. For now we'll just treat any postpone
          // as dynamic.
          SSRIsDynamic = true
          return
        }

        const prerender = require('react-dom/static.edge')
          .prerender as (typeof import('react-dom/static.edge'))['prerender']
        const { prelude: htmlStream } =
          await prerenderAndAbortInSequentialTasks(
            () =>
              prerenderAsyncStorage.run(
                ssrPrerenderStore,
                prerender,
                <App
                  reactServerStream={reactServerResult.asUnclosingStream()}
                  preinitScripts={preinitScripts}
                  clientReferenceManifest={clientReferenceManifest}
                  ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
                  nonce={ctx.nonce}
                />,
                {
                  signal: SSRController.signal,
                  onError: SSROnError,
                  onPostpone: SSROnPostpone,
                  // When debugging the static shell, client-side rendering should be
                  // disabled to prevent blanking out the page.
                  bootstrapScripts: renderOpts.isDebugStaticShell
                    ? []
                    : [bootstrapScript],
                }
              ),
            () => {
              SSRController.abort(abortReason)
            }
          )

        if (SSRIsDynamic) {
          // Something dynamic happened in the SSR phase of the render. This could be IO or it could be
          // a dynamic API like accessing searchParams in a client Page
          const dynamicReason = getFirstDynamicReason(dynamicTracking)
          if (dynamicReason) {
            throw new DynamicServerError(
              `Route ${staticGenerationStore.route} couldn't be rendered statically because it used \`${dynamicReason}\`. See more info here: https://nextjs.org/docs/messages/dynamic-server-error`
            )
          } else {
            throw new DynamicServerError(
              `Route ${staticGenerationStore.route} couldn't be rendered statically because it used IO that was not cached in a Client Component. See more info here: https://nextjs.org/docs/messages/dynamic-io`
            )
          }
        }

        metadata.flightData = await streamToBuffer(reactServerResult.asStream())

        const getServerInsertedHTML = makeGetServerInsertedHTML({
          polyfills,
          renderServerInsertedHTML,
          serverCapturedErrors: allCapturedErrors,
          basePath: renderOpts.basePath,
          tracingMetadata: tracingMetadata,
        })
        const validateRootLayout = renderOpts.dev
        return {
          digestErrorsMap: reactServerErrorsByDigest,
          ssrErrors: allCapturedErrors,
          stream: await continueFizzStream(htmlStream, {
            inlinedDataStream: createInlinedDataReadableStream(
              reactServerResult.consumeAsStream(),
              ctx.nonce,
              formState
            ),
            isStaticGeneration: true,
            getServerInsertedHTML,
            serverInsertedHTMLToHead: true,
            validateRootLayout,
          }),
          dynamicTracking,
        }
      }
    } else if (renderOpts.experimental.isRoutePPREnabled) {
      // We're statically generating with PPR and need to do dynamic tracking
      dynamicTracking = createDynamicTrackingState(
        renderOpts.isDebugDynamicAccesses
      )
      const reactServerPrerenderStore = {
        cacheSignal: null,
        controller: null,
        dynamicTracking,
      }
      const RSCPayload = await getRSCPayload(tree, ctx, res.statusCode === 404)
      const reactServerResult = (reactServerPrerenderResult =
        await createReactServerPrerenderResultFromRender(
          prerenderAsyncStorage.run(
            reactServerPrerenderStore,
            ComponentMod.renderToReadableStream,
            // ... the arguments for the function to run
            RSCPayload,
            clientReferenceManifest.clientModules,
            {
              onError: serverComponentsErrorHandler,
              nonce: ctx.nonce,
            }
          )
        ))

      const ssrPrerenderStore: PrerenderStore = {
        cacheSignal: null,
        controller: null,
        dynamicTracking,
      }

      const prerender = require('react-dom/static.edge')
        .prerender as (typeof import('react-dom/static.edge'))['prerender']
      const { prelude, postponed } = await prerenderAsyncStorage.run(
        ssrPrerenderStore,
        prerender,
        <App
          reactServerStream={reactServerResult.asUnclosingStream()}
          preinitScripts={preinitScripts}
          clientReferenceManifest={clientReferenceManifest}
          ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
          nonce={ctx.nonce}
        />,
        {
          onError: htmlRendererErrorHandler,
          onHeaders: (headers: Headers) => {
            headers.forEach((value, key) => {
              setHeader(key, value)
            })
          },
          maxHeadersLength: renderOpts.reactMaxHeadersLength,
          // When debugging the static shell, client-side rendering should be
          // disabled to prevent blanking out the page.
          bootstrapScripts: renderOpts.isDebugStaticShell
            ? []
            : [bootstrapScript],
        }
      )
      const getServerInsertedHTML = makeGetServerInsertedHTML({
        polyfills,
        renderServerInsertedHTML,
        serverCapturedErrors: allCapturedErrors,
        basePath: renderOpts.basePath,
        tracingMetadata: tracingMetadata,
      })

      // After awaiting here we've waited for the entire RSC render to complete. Crucially this means
      // that when we detect whether we've used dynamic APIs below we know we'll have picked up even
      // parts of the React Server render that might not be used in the SSR render.
      const flightData = await streamToBuffer(reactServerResult.asStream())

      if (shouldGenerateStaticFlightData(staticGenerationStore)) {
        metadata.flightData = flightData
      }

      /**
       * When prerendering there are three outcomes to consider
       *
       *   Dynamic HTML:      The prerender has dynamic holes (caused by using Next.js Dynamic Rendering APIs)
       *                      We will need to resume this result when requests are handled and we don't include
       *                      any server inserted HTML or inlined flight data in the static HTML
       *
       *   Dynamic Data:      The prerender has no dynamic holes but dynamic APIs were used. We will not
       *                      resume this render when requests are handled but we will generate new inlined
       *                      flight data since it is dynamic and differences may end up reconciling on the client
       *
       *   Static:            The prerender has no dynamic holes and no dynamic APIs were used. We statically encode
       *                      all server inserted HTML and flight data
       */
      // First we check if we have any dynamic holes in our HTML prerender
      if (accessedDynamicData(dynamicTracking)) {
        if (postponed != null) {
          // Dynamic HTML case.
          metadata.postponed = getDynamicHTMLPostponedState(
            postponed,
            fallbackRouteParams
          )
        } else {
          // Dynamic Data case.
          metadata.postponed = getDynamicDataPostponedState()
        }
        // Regardless of whether this is the Dynamic HTML or Dynamic Data case we need to ensure we include
        // server inserted html in the static response because the html that is part of the prerender may depend on it
        // It is possible in the set of stream transforms for Dynamic HTML vs Dynamic Data may differ but currently both states
        // require the same set so we unify the code path here
        reactServerResult.consume()
        return {
          digestErrorsMap: reactServerErrorsByDigest,
          ssrErrors: allCapturedErrors,
          stream: await continueDynamicPrerender(prelude, {
            getServerInsertedHTML,
          }),
          dynamicTracking,
        }
      } else if (fallbackRouteParams && fallbackRouteParams.size > 0) {
        // Rendering the fallback case.
        metadata.postponed = getDynamicDataPostponedState()

        return {
          digestErrorsMap: reactServerErrorsByDigest,
          ssrErrors: allCapturedErrors,
          stream: await continueDynamicPrerender(prelude, {
            getServerInsertedHTML,
          }),
          dynamicTracking,
        }
      } else {
        // Static case
        // We still have not used any dynamic APIs. At this point we can produce an entirely static prerender response
        if (staticGenerationStore.forceDynamic) {
          throw new StaticGenBailoutError(
            'Invariant: a Page with `dynamic = "force-dynamic"` did not trigger the dynamic pathway. This is a bug in Next.js'
          )
        }

        let htmlStream = prelude
        if (postponed != null) {
          // We postponed but nothing dynamic was used. We resume the render now and immediately abort it
          // so we can set all the postponed boundaries to client render mode before we store the HTML response
          const resume = require('react-dom/server.edge')
            .resume as (typeof import('react-dom/server.edge'))['resume']

          // We don't actually want to render anything so we just pass a stream
          // that never resolves. The resume call is going to abort immediately anyway
          const foreverStream = new ReadableStream<Uint8Array>()

          const resumeStream = await resume(
            <App
              reactServerStream={foreverStream}
              preinitScripts={() => {}}
              clientReferenceManifest={clientReferenceManifest}
              ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
              nonce={ctx.nonce}
            />,
            JSON.parse(JSON.stringify(postponed)),
            {
              signal: createPostponedAbortSignal('static prerender resume'),
              onError: htmlRendererErrorHandler,
              nonce: ctx.nonce,
            }
          )

          // First we write everything from the prerender, then we write everything from the aborted resume render
          htmlStream = chainStreams(prelude, resumeStream)
        }

        return {
          digestErrorsMap: reactServerErrorsByDigest,
          ssrErrors: allCapturedErrors,
          stream: await continueStaticPrerender(htmlStream, {
            inlinedDataStream: createInlinedDataReadableStream(
              reactServerResult.consumeAsStream(),
              ctx.nonce,
              formState
            ),
            getServerInsertedHTML,
          }),
          dynamicTracking,
        }
      }
    } else {
      // This is a regular static generation. We don't do dynamic tracking because we rely on
      // the old-school dynamic error handling to bail out of static generation
      const RSCPayload = await getRSCPayload(tree, ctx, res.statusCode === 404)
      const reactServerResult = (reactServerPrerenderResult =
        await createReactServerPrerenderResultFromRender(
          ComponentMod.renderToReadableStream(
            RSCPayload,
            clientReferenceManifest.clientModules,
            {
              onError: serverComponentsErrorHandler,
              nonce: ctx.nonce,
            }
          )
        ))

      const renderToReadableStream = require('react-dom/server.edge')
        .renderToReadableStream as (typeof import('react-dom/server.edge'))['renderToReadableStream']

      const htmlStream = await renderToReadableStream(
        <App
          reactServerStream={reactServerResult.asUnclosingStream()}
          preinitScripts={preinitScripts}
          clientReferenceManifest={clientReferenceManifest}
          ServerInsertedHTMLProvider={ServerInsertedHTMLProvider}
          nonce={ctx.nonce}
        />,
        {
          onError: htmlRendererErrorHandler,
          nonce: ctx.nonce,
          // When debugging the static shell, client-side rendering should be
          // disabled to prevent blanking out the page.
          bootstrapScripts: renderOpts.isDebugStaticShell
            ? []
            : [bootstrapScript],
        }
      )

      if (shouldGenerateStaticFlightData(staticGenerationStore)) {
        metadata.flightData = await streamToBuffer(reactServerResult.asStream())
      }

      const getServerInsertedHTML = makeGetServerInsertedHTML({
        polyfills,
        renderServerInsertedHTML,
        serverCapturedErrors: allCapturedErrors,
        basePath: renderOpts.basePath,
        tracingMetadata: tracingMetadata,
      })
      return {
        digestErrorsMap: reactServerErrorsByDigest,
        ssrErrors: allCapturedErrors,
        stream: await continueFizzStream(htmlStream, {
          inlinedDataStream: createInlinedDataReadableStream(
            reactServerResult.consumeAsStream(),
            ctx.nonce,
            formState
          ),
          isStaticGeneration: true,
          getServerInsertedHTML,
          serverInsertedHTMLToHead: true,
        }),
      }
    }
  } catch (err) {
    if (
      isStaticGenBailoutError(err) ||
      (typeof err === 'object' &&
        err !== null &&
        'message' in err &&
        typeof err.message === 'string' &&
        err.message.includes(
          'https://nextjs.org/docs/advanced-features/static-html-export'
        ))
    ) {
      // Ensure that "next dev" prints the red error overlay
      throw err
    }

    // If this is a static generation error, we need to throw it so that it
    // can be handled by the caller if we're in static generation mode.
    if (isDynamicServerError(err)) {
      throw err
    }

    // If a bailout made it to this point, it means it wasn't wrapped inside
    // a suspense boundary.
    const shouldBailoutToCSR = isBailoutToCSRError(err)
    if (shouldBailoutToCSR) {
      const stack = getStackWithoutErrorMessage(err)
      error(
        `${err.reason} should be wrapped in a suspense boundary at page "${ctx.pagePath}". Read more: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout\n${stack}`
      )

      throw err
    }

    if (isNotFoundError(err)) {
      res.statusCode = 404
    }
    let hasRedirectError = false
    if (isRedirectError(err)) {
      hasRedirectError = true
      res.statusCode = getRedirectStatusCodeFromError(err)
      if (err.mutableCookies) {
        const headers = new Headers()

        // If there were mutable cookies set, we need to set them on the
        // response.
        if (appendMutableCookies(headers, err.mutableCookies)) {
          setHeader('set-cookie', Array.from(headers.values()))
        }
      }
      const redirectUrl = addPathPrefix(
        getURLFromRedirectError(err),
        renderOpts.basePath
      )
      setHeader('Location', redirectUrl)
    }

    const is404 = res.statusCode === 404
    if (!is404 && !hasRedirectError && !shouldBailoutToCSR) {
      res.statusCode = 500
    }

    if (reactServerPrerenderResult === null) {
      // We errored when we did not have an RSC stream to read from. This is not just a render
      // error, we need to throw early
      throw err
    }

    const errorType = is404
      ? 'not-found'
      : hasRedirectError
        ? 'redirect'
        : undefined

    const [errorPreinitScripts, errorBootstrapScript] = getRequiredScripts(
      renderOpts.buildManifest,
      ctx.assetPrefix,
      renderOpts.crossOrigin,
      renderOpts.subresourceIntegrityManifest,
      getAssetQueryString(ctx, false),
      ctx.nonce,
      '/_not-found/page'
    )

    const errorRSCPayload = await getErrorRSCPayload(tree, ctx, errorType)

    const errorServerStream = ComponentMod.renderToReadableStream(
      errorRSCPayload,
      clientReferenceManifest.clientModules,
      {
        onError: serverComponentsErrorHandler,
        nonce: ctx.nonce,
      }
    )

    try {
      const fizzStream = await renderToInitialFizzStream({
        ReactDOMServer: require('react-dom/server.edge'),
        element: (
          <AppWithoutContext
            reactServerStream={errorServerStream}
            preinitScripts={errorPreinitScripts}
            clientReferenceManifest={clientReferenceManifest}
            nonce={ctx.nonce}
          />
        ),
        streamOptions: {
          nonce: ctx.nonce,
          // Include hydration scripts in the HTML
          bootstrapScripts: [errorBootstrapScript],
          formState,
        },
      })

      if (shouldGenerateStaticFlightData(staticGenerationStore)) {
        metadata.flightData = await streamToBuffer(
          reactServerPrerenderResult.asStream()
        )
      }

      const validateRootLayout = renderOpts.dev
      return {
        // Returning the error that was thrown so it can be used to handle
        // the response in the caller.
        digestErrorsMap: reactServerErrorsByDigest,
        ssrErrors: allCapturedErrors,
        stream: await continueFizzStream(fizzStream, {
          inlinedDataStream: createInlinedDataReadableStream(
            // This is intentionally using the readable datastream from the
            // main render rather than the flight data from the error page
            // render
            reactServerPrerenderResult.consumeAsStream(),
            ctx.nonce,
            formState
          ),
          isStaticGeneration: true,
          getServerInsertedHTML: makeGetServerInsertedHTML({
            polyfills,
            renderServerInsertedHTML,
            serverCapturedErrors: [],
            basePath: renderOpts.basePath,
            tracingMetadata: tracingMetadata,
          }),
          serverInsertedHTMLToHead: true,
          validateRootLayout,
        }),
        dynamicTracking,
      }
    } catch (finalErr: any) {
      if (process.env.NODE_ENV === 'development' && isNotFoundError(finalErr)) {
        const bailOnNotFound: typeof import('../../client/components/dev-root-not-found-boundary').bailOnNotFound =
          require('../../client/components/dev-root-not-found-boundary').bailOnNotFound
        bailOnNotFound()
      }
      throw finalErr
    }
  }
}

const loadingChunks: Set<Promise<unknown>> = new Set()
const chunkListeners: Array<(x?: unknown) => void> = []

function trackChunkLoading(load: Promise<unknown>) {
  loadingChunks.add(load)
  load.finally(() => {
    if (loadingChunks.has(load)) {
      loadingChunks.delete(load)
      if (loadingChunks.size === 0) {
        // We are not currently loading any chunks. We can notify all listeners
        for (let i = 0; i < chunkListeners.length; i++) {
          chunkListeners[i]()
        }
        chunkListeners.length = 0
      }
    }
  })
}

export async function warmFlightResponse(
  flightStream: BinaryStreamOf<any>,
  clientReferenceManifest: DeepReadonly<ClientReferenceManifest>
) {
  let createFromReadableStream
  if (process.env.TURBOPACK) {
    createFromReadableStream =
      // eslint-disable-next-line import/no-extraneous-dependencies
      require('react-server-dom-turbopack/client.edge').createFromReadableStream
  } else {
    createFromReadableStream =
      // eslint-disable-next-line import/no-extraneous-dependencies
      require('react-server-dom-webpack/client.edge').createFromReadableStream
  }

  try {
    createFromReadableStream(flightStream, {
      ssrManifest: {
        moduleLoading: clientReferenceManifest.moduleLoading,
        moduleMap: clientReferenceManifest.ssrModuleMapping,
      },
    })
  } catch {
    // We don't want to handle errors here but we don't want it to
    // interrupt the outer flow. We simply ignore it here and expect
    // it will bubble up during a render
  }

  // We'll wait at least one task and then if no chunks have started to load
  // we'll we can infer that there are none to load from this flight response
  trackChunkLoading(waitAtLeastOneReactRenderTask())
  return new Promise((r) => {
    chunkListeners.push(r)
  })
}
