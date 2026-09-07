import type { MoveKeyframeReference, TacticDocumentV1 } from '../domain/model/types'
import { ballPossessionHistory } from '../domain/timeline/ballPossession'
import { projectFrameAtKeyframe } from '../domain/timeline/projectFrame'

export const LOOSE_PASS_POSSESSION_NOTICE = '空传需要先接到球；请选择接球帧，或接球后仍持球的时刻。'

/** Navigation only: never edit the tactic or invent a possession event. */
export function planLoosePassActor(
  document: TacticDocumentV1,
  currentTime: number,
  currentKeyframe: MoveKeyframeReference | null,
  requestedActorId?: string,
) {
  const frame = projectFrameAtKeyframe(document, currentTime, currentKeyframe)
  const actorId = requestedActorId ?? frame.ball.carrierId
  if (!actorId || !frame.players.some((player) => player.id === actorId)) return null
  if (frame.ball.carrierId === actorId) return { actorId, currentTime, currentKeyframe }

  // Reuse the solved ball-event history, not repeated flight/position solving.
  const nextHolding = ballPossessionHistory(document).intervals.find((interval) => (
    interval.actorId === actorId && interval.start >= currentTime && interval.end > interval.start
  ))
  if (!nextHolding) return null
  const received = projectFrameAtKeyframe(document, nextHolding.start, null)
  if (received.ball.carrierId !== actorId) return null
  return { actorId, currentTime: nextHolding.start, currentKeyframe: null }
}
