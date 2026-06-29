/** @type {Record<string, object>} */
export const roomLiveCache = {}

/** @type {Record<string, Array<{ socketId: string, userId: string, slotTime: string, slotDate: string, userEmail: string, difficultyPreference?: string, topicPreference?: string }>>} */
export const waitingPool = {}

/** @type {Record<string, Map<string, string>>} */
export const roomPeers = {}

/** @type {Record<string, object>} */
export const roomQuestions = {}

/** @type {Record<string, string>} */
export const roomFirstPeer = {}

/** @type {Record<string, string>} */
export const roomFirstPeerUserId = {}

/** @type {Record<string, Record<string, string>>} */
export const roomPeerDifficultyPrefs = {}

/** @type {Record<string, Record<string, string>>} */
export const roomPeerTopicPrefs = {}

/** @type {Record<string, string>} */
export const roomDifficultyPref = {}

/** @type {Record<string, string>} */
export const roomTopicPref = {}

/** @type {Record<string, string>} */
export const userSocketMap = {}

/** @type {Set<string>} */
export const processedSlotDates = new Set()

/** @type {Record<string, boolean>} */
export const roomTimerStarted = {}

/** Serialize role assignment per room to prevent simultaneous-join races. */
export const roomRoleLocks = new Map()
