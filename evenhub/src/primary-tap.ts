import type { TurnController } from './controller';
import type { G2Recorder } from './recorder';

interface PrimaryTapActions {
  controller: Pick<
    TurnController,
    'state' | 'openConfirmationChoice' | 'confirm'
  >;
  recorder: Pick<G2Recorder, 'start' | 'finish'>;
}

export async function handlePrimaryTap({
  controller,
  recorder,
}: PrimaryTapActions): Promise<void> {
  const state = controller.state;
  if (state.kind === 'ready' && state.capabilities?.voice) {
    await recorder.start();
    return;
  }
  if (state.kind === 'recording') {
    await recorder.finish();
    return;
  }
  if (state.kind !== 'review') return;
  if (!state.choiceOpen) {
    controller.openConfirmationChoice();
    return;
  }
  const decision = await controller.confirm();
  if (decision === 'discard') await recorder.start();
}
