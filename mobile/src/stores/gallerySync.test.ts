import {PhotoInfo} from "@/types/asg"

import {useGallerySyncStore} from "./gallerySync"

const createPhoto = (name: string): PhotoInfo => ({
  name,
  url: `file://${name}`,
  download: `file://${name}`,
  size: 1,
  modified: Date.now(),
})

describe("gallerySync store", () => {
  beforeEach(() => {
    useGallerySyncStore.getState().reset()
  })

  it("removes deleted items from the retained queue", () => {
    const store = useGallerySyncStore.getState()
    const files = [createPhoto("first.jpg"), createPhoto("second.jpg"), createPhoto("third.jpg")]

    store.setSyncing(files)
    store.onFileComplete("first.jpg")
    store.onFileComplete("second.jpg")
    store.onFileComplete("third.jpg")
    store.setSyncComplete()
    useGallerySyncStore.getState().removeFilesFromQueue(["second.jpg"])

    const nextState = useGallerySyncStore.getState()

    expect(nextState.queue.map((file) => file.name)).toEqual(["first.jpg", "third.jpg"])
    expect(nextState.totalFiles).toBe(2)
    expect(nextState.completedFiles).toBe(2)
  })
})
