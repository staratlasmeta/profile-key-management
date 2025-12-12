import { PublicKey } from '@solana/web3.js';

export const PLAYER_PROFILE_PROGRAM_ID = new PublicKey('pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9');

// Program ID options with labels
export interface ProgramIdOption {
  id: string;
  label: string;
  network: string;
}

export const PROGRAM_ID_OPTIONS: ProgramIdOption[] = [
  {
    id: 'pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9',
    label: 'Solana Mainnet',
    network: 'mainnet',
  },
  {
    id: 'PprofUW1pURCnMW2si88GWPXEEK3Bvh9Tksy8WtnoYJ',
    label: 'Atlasnet',
    network: 'atlasnet',
  },
  {
    id: 'custom',
    label: 'Custom',
    network: 'custom',
  },
];

// LocalStorage key for custom program ID
export const CUSTOM_PROGRAM_ID_KEY = 'player-profile-custom-program-id';

// Legacy export for backwards compatibility
export const KNOWN_PROGRAM_IDS = PROGRAM_ID_OPTIONS.map(opt => opt.id);

