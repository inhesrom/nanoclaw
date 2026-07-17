import { OsEventTypeList } from '@evenrealities/even_hub_sdk';

export interface HubInteractionEvent {
  sysEvent?: { eventType?: number };
  textEvent?: { eventType?: number };
}

export type HubInteraction =
  | 'primary'
  | 'previous'
  | 'next'
  | 'exit'
  | 'foreground-exit'
  | 'shutdown'
  | undefined;

export function routeHubInteraction(
  event: HubInteractionEvent,
): HubInteraction {
  // CLICK_EVENT is protobuf enum value 0, so some hosts omit eventType when
  // serializing a click. Event object presence distinguishes that default from
  // no event at all.
  const sysType = event.sysEvent
    ? (event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT)
    : undefined;
  const textType = event.textEvent
    ? (event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT)
    : undefined;

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    return 'exit';
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) return 'previous';
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'next';
  if (
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT
  ) {
    return 'primary';
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    return 'foreground-exit';
  }
  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    return 'shutdown';
  }
  return undefined;
}
