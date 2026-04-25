export type RemovableSubscription = {
  remove: () => void
}

export type SubscriptionLike = RemovableSubscription | (() => void)

export const toRemovableSubscription = (subscription: SubscriptionLike): RemovableSubscription => {
  if (typeof subscription === "function") {
    return {remove: subscription}
  }

  return subscription
}
