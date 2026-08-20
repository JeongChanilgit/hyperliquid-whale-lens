import type { PositionAction, TradingEvent } from "./types";

const actionLabel = (action: PositionAction): string => {
  switch (action) {
    case "LONG_ENTRY": return "롱 진입";
    case "SHORT_ENTRY": return "숏 진입";
    case "LONG_ADD": return "롱 추가진입";
    case "SHORT_ADD": return "숏 추가진입";
    case "LONG_REDUCE": return "롱 부분청산";
    case "SHORT_REDUCE": return "숏 부분청산";
    case "LONG_CLOSE": return "롱 청산";
    case "SHORT_CLOSE": return "숏 청산";
  }
};

export const tradingEventLabel = (
  event: Pick<TradingEvent, "actions" | "isLossClose" | "isTriggerStop">,
  closePnlLabel?: string,
): string => {
  const labels = event.actions.map((action) => {
    if (!action.endsWith("_CLOSE")) return actionLabel(action);
    const direction = action.startsWith("LONG_") ? "롱" : "숏";
    const closeLabel = event.isTriggerStop
      ? `${direction} 손절`
      : event.isLossClose
        ? `${direction} 손실청산`
        : `${direction} 청산`;
    return closePnlLabel ? `${closeLabel} ${closePnlLabel}` : closeLabel;
  });
  return labels.join(" → ");
};
