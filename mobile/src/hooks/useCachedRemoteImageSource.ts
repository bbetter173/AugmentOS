import {Image} from "expo-image"
import {useEffect, useState} from "react"

const inflight = new Map<string, Promise<string | null>>()
const resolvedCache = new Map<string, string>()

async function resolveCachedPath(url: string): Promise<string | null> {
  if (resolvedCache.has(url)) return resolvedCache.get(url)!
  if (inflight.has(url)) return inflight.get(url)!

  const promise = (async () => {
    try {
      let path = await Image.getCachePathAsync(url)
      if (!path) {
        const ok = await Image.prefetch(url, {cachePolicy: "memory-disk"})
        if (!ok) return null
        path = await Image.getCachePathAsync(url)
      }
      if (path) {
        const fileUri = path.startsWith("file://") ? path : `file://${path}`
        resolvedCache.set(url, fileUri)
        return fileUri
      }
      return null
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, promise)
  return promise
}

export function useCachedRemoteImageSource<T>(source: T): T | {uri: string} {
  const url = typeof source === "string" ? source : null
  const isRemote = url !== null && (url.startsWith("http://") || url.startsWith("https://"))
  const [resolved, setResolved] = useState<string | null>(() =>
    isRemote ? resolvedCache.get(url!) ?? null : null,
  )

  useEffect(() => {
    if (!isRemote) return
    if (resolvedCache.has(url!)) {
      setResolved(resolvedCache.get(url!)!)
      return
    }
    let cancelled = false
    resolveCachedPath(url!).then((path) => {
      if (!cancelled && path) setResolved(path)
    })
    return () => {
      cancelled = true
    }
  }, [isRemote, url])

  if (isRemote && resolved) return {uri: resolved}
  return source as T
}
