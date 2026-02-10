import { produce } from "immer";
import { create } from "zustand";

export interface StellarWalletState {
  set: (x: (s: StellarWalletState) => void) => void;
  get: () => StellarWalletState;
  address: string | null;
  connected: boolean;
}

const useStellarWalletStore = create<StellarWalletState>((set, get) => {
  const setProducerFn = (fn: (s: StellarWalletState) => void) =>
    set(produce(fn));
  return {
    set: setProducerFn,
    get: () => get(),
    address: null,
    connected: false,
  };
});

export default useStellarWalletStore;
