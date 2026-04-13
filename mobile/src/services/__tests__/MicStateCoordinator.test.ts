/// <reference types="bun-types" />
import { describe, expect, test, beforeEach, mock } from "bun:test"

// Mock CoreModule since it's a native module
const mockUpdate = mock(() => {})
mock.module("core", () => ({
  default: { update: mockUpdate },
}))

// Import after mock
import MicStateCoordinator from "../MicStateCoordinator"

describe("MicStateCoordinator", () => {
  let coordinator: MicStateCoordinator

  beforeEach(() => {
    // Get singleton and reset to clean state
    coordinator = MicStateCoordinator.getInstance()
    coordinator.reset()
    mockUpdate.mockClear()
  })

  test("cloud-only PCM requirement", () => {
    coordinator.setCloudRequirements({ pcm: true, lc3: false, transcript: false, bypass_vad: false })
    expect(mockUpdate).toHaveBeenCalledWith("core", expect.objectContaining({
      should_send_pcm: true,
      should_send_lc3: false,
    }))
  })

  test("local-only LC3 requirement", () => {
    coordinator.setLocalRequirements({ pcm: false, lc3: true })
    expect(mockUpdate).toHaveBeenCalledWith("core", expect.objectContaining({
      should_send_lc3: true,
    }))
  })

  test("union of cloud + local", () => {
    coordinator.setCloudRequirements({ pcm: true, lc3: false, transcript: true, bypass_vad: false })
    coordinator.setLocalRequirements({ pcm: false, lc3: true })
    // Last call should have the union
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(expect.objectContaining({
      should_send_pcm: true,  // cloud wants it
      should_send_lc3: true,  // local wants it
      should_send_transcript: true, // cloud only
    }))
  })

  test("both off means all false", () => {
    coordinator.setCloudRequirements({ pcm: false, lc3: false, transcript: false, bypass_vad: false })
    coordinator.setLocalRequirements({ pcm: false, lc3: false })
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(expect.objectContaining({
      should_send_pcm: false,
      should_send_lc3: false,
    }))
  })

  test("local unsubscribe doesn't kill cloud mic", () => {
    coordinator.setCloudRequirements({ pcm: false, lc3: true, transcript: true, bypass_vad: false })
    coordinator.setLocalRequirements({ pcm: false, lc3: true })
    // Now local stops needing lc3
    coordinator.setLocalRequirements({ pcm: false, lc3: false })
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    // Cloud still wants lc3
    expect(lastCall[1]).toEqual(expect.objectContaining({
      should_send_lc3: true,
    }))
  })
})
