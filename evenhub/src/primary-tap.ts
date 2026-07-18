import type { TurnController } from './controller';
import type { G2Recorder } from './recorder';

interface PrimaryTapActions {
  controller: Pick<TurnController, 'state' | 'newTurn' | 'nextPage'>;
  recorder: Pick<G2Recorder, 'start' | 'finish'>;
}

export async function handlePrimaryTap({
  controller,
  recorder,
}: PrimaryTapActions): Promise<void> {
  const state = controller.state;
  if (state.kind === 'ready') {
    await recorder.start();
    return;
  }
  if (state.kind === 'recording') {
    await recorder.finish();
    return;
  }
  if (state.kind !== 'answer') return;

  const hasLaterPage = state.page < state.pages.length - 1;
  const hasLaterTurn = state.session.turn < state.session.turns.length - 1;
  if (hasLaterPage || hasLaterTurn) {
    controller.nextPage();
    return;
  }

  await controller.newTurn();
  await recorder.start();
}
