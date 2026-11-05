import { useParams } from '@decky/ui';
import { createContext, useContext } from 'react';

/**
 * The game the "change music" UI is about. In Big Picture it comes from the
 * route; in a desktop popup there is no router, so it is provided here.
 */
export const AppIdContext = createContext<number | null>(null);

export function useAppId(): number {
  const fromContext = useContext(AppIdContext);
  const params = useParams<{ appid?: string }>();
  if (fromContext !== null) return fromContext;
  return parseInt(params?.appid ?? '0');
}
