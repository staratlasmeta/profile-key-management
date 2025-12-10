import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, BN } from '@staratlas/anchor';
import {
    PlayerProfile,
    PlayerProfileProgram,
    ProfilePermissions,
    PlayerName
} from '@staratlas/player-profile';
import { walletToAsyncSigner, readAllFromRPC, readFromRPCNullable } from '@staratlas/data-source';
import { PLAYER_PROFILE_PROGRAM_ID, KNOWN_PROGRAM_IDS } from '../utils/constants';

type TransferStep = 'idle' | 'enter_destination' | 'sign_current' | 'connect_destination' | 'sign_destination' | 'complete' | 'expired';

interface TransferState {
    step: TransferStep;
    destinationPubkey: string;
    originalAuthPubkey: string;
    partiallySignedTx: string | null; // Base64 encoded
    profileKey: string;
    profileCreatedAt: number;
    profileKeyThreshold: number;
    signedAt: number | null; // Timestamp when first signature was obtained
    error: string | null;
}

const initialTransferState: TransferState = {
    step: 'idle',
    destinationPubkey: '',
    originalAuthPubkey: '',
    partiallySignedTx: null,
    profileKey: '',
    profileCreatedAt: 0,
    profileKeyThreshold: 1,
    signedAt: null,
    error: null,
};

// Blockhash validity window (90 seconds to be safe, actual is ~60-150 seconds)
const BLOCKHASH_VALIDITY_SECONDS = 42;

export const ProfileManager = () => {
    const { connection } = useConnection();
    const wallet = useWallet();
    const { setVisible: setWalletModalVisible } = useWalletModal();
    const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
    const [profileNames, setProfileNames] = useState<Map<string, string | null>>(new Map());
    const [loading, setLoading] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [selectedProfile, setSelectedProfile] = useState<PlayerProfile | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [programId, setProgramId] = useState<string>(PLAYER_PROFILE_PROGRAM_ID.toBase58());
    const [debugInfo, setDebugInfo] = useState<string>('');
    
    // Transfer auth state
    const [transferState, setTransferState] = useState<TransferState>(initialTransferState);
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
    const prevWalletRef = useRef<string | null>(null);

    // Check if we're in the middle of a transfer (after first signature) or showing completion
    // This prevents automatic profile refresh until user acknowledges the result
    const isTransferInProgress = 
        transferState.step === 'connect_destination' || 
        transferState.step === 'sign_destination' || 
        transferState.step === 'expired' ||
        transferState.step === 'complete';

    // Countdown timer for blockhash validity
    useEffect(() => {
        if (!transferState.signedAt || transferState.step === 'complete' || transferState.step === 'expired') {
            setTimeRemaining(null);
            return;
        }

        const updateTimer = () => {
            const elapsed = Math.floor((Date.now() - transferState.signedAt!) / 1000);
            const remaining = BLOCKHASH_VALIDITY_SECONDS - elapsed;
            
            if (remaining <= 0) {
                setTimeRemaining(0);
                setTransferState(prev => ({
                    ...prev,
                    step: 'expired',
                    error: 'Transaction expired. The blockhash is no longer valid. Please restart the transfer.'
                }));
            } else {
                setTimeRemaining(remaining);
            }
        };

        // Update immediately
        updateTimer();

        // Then update every second
        const interval = setInterval(updateTimer, 1000);
        return () => clearInterval(interval);
    }, [transferState.signedAt, transferState.step]);

    const program = useMemo(() => {
        const provider = new AnchorProvider(connection, wallet as any, {});
        try {
            return PlayerProfileProgram.buildProgram(new PublicKey(programId), provider);
        } catch (e) {
            console.error('Invalid program ID:', programId, e);
            return null;
        }
    }, [connection, wallet, programId]);

    // Fetch the player name for a given profile
    const fetchProfileName = useCallback(async (profileKey: PublicKey): Promise<string | null> => {
        if (!program) return null;
        
        try {
            const [nameKey] = PlayerName.findAddress(program, profileKey);
            const nameAccount = await readFromRPCNullable(
                connection,
                program,
                nameKey,
                PlayerName
            );
            return nameAccount?.name || null;
        } catch (e) {
            console.error('Error fetching profile name:', e);
            return null;
        }
    }, [connection, program]);

    const fetchProfiles = useCallback(async () => {
        // Don't fetch profiles if we're in the middle of a transfer
        if (isTransferInProgress) {
            console.log("Skipping profile fetch - transfer in progress");
            return;
        }
        
        if (!wallet.publicKey || !program) return;
        setLoading(true);
        setDebugInfo('');

        try {
            console.log("Fetching profiles for:", wallet.publicKey.toBase58());
            console.log("Using RPC Endpoint:", connection.rpcEndpoint);
            console.log("Using Program ID:", programId);

            const programAccount = await connection.getAccountInfo(new PublicKey(programId));
            if (!programAccount) {
                setDebugInfo(`Program ${programId} does not exist on this network. Try a different program ID.`);
                console.error("Program does not exist:", programId);
                setProfiles([]);
                return;
            }

            console.log("Program exists, fetching profiles for wallet:", wallet.publicKey.toBase58());

            const results = await readAllFromRPC(
                connection,
                program,
                PlayerProfile,
                'confirmed',
                [
                    {
                        memcmp: {
                            offset: (PlayerProfile as any).MIN_DATA_SIZE + 2,
                            bytes: wallet.publicKey.toBase58(),
                        },
                    },
                ]
            );

            const myProfiles = results
                .filter((r) => r.type === 'ok')
                .map((r) => (r as any).data as PlayerProfile);

            console.log("Found matching profiles:", myProfiles.length);
            setDebugInfo(`Found ${myProfiles.length} profiles owned by your wallet.`);

            if (myProfiles.length === 0) {
                setDebugInfo(`No profiles found. Your wallet is not an auth key on any profiles for this program.`);
            }

            setProfiles(myProfiles);

            // Fetch names for all profiles in parallel
            const namesMap = new Map<string, string | null>();
            await Promise.all(
                myProfiles.map(async (profile) => {
                    const name = await fetchProfileName(profile.key);
                    namesMap.set(profile.key.toBase58(), name);
                })
            );
            setProfileNames(namesMap);
        } catch (e) {
            console.error("Error fetching profiles:", e);
            setDebugInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setLoading(false);
        }
    }, [connection, wallet.publicKey, program, programId, isTransferInProgress, fetchProfileName]);

    useEffect(() => {
        fetchProfiles();
    }, [fetchProfiles]);

    // Watch for wallet changes during transfer flow
    useEffect(() => {
        const currentWallet = wallet.publicKey?.toBase58() || null;
        
        // If we're waiting for destination wallet connection
        if (transferState.step === 'connect_destination' && currentWallet) {
            if (currentWallet === transferState.destinationPubkey) {
                // Correct wallet connected! Move to sign step
                console.log("Destination wallet connected:", currentWallet);
                setTransferState(prev => ({ ...prev, step: 'sign_destination', error: null }));
            } else if (currentWallet !== transferState.originalAuthPubkey) {
                // Wrong wallet connected
                setTransferState(prev => ({
                    ...prev,
                    error: `Wrong wallet connected. Expected: ${transferState.destinationPubkey.slice(0, 4)}...${transferState.destinationPubkey.slice(-4)}`
                }));
            }
        }
        
        prevWalletRef.current = currentWallet;
    }, [wallet.publicKey, transferState.step, transferState.destinationPubkey, transferState.originalAuthPubkey]);

    const handleDeleteKey = async (profile: PlayerProfile, keyIndex: number) => {
        if (!wallet.publicKey || !wallet.signTransaction) return;
        setProcessing(true);
        try {
            const asyncSigner = walletToAsyncSigner(wallet as any);
            const ixReturnFn = PlayerProfile.removeKeys(
                program as any,
                {
                    playerProfileProgram: program as any,
                    profile: profile,
                    key: asyncSigner
                },
                'funder',
                [keyIndex, keyIndex + 1],
            );

            const ixsWithSigners = await ixReturnFn(asyncSigner);
            const ixsWithSignersArray = Array.isArray(ixsWithSigners) ? ixsWithSigners : [ixsWithSigners];
            const instructions = ixsWithSignersArray.map(i => i.instruction);

            const tx = new Transaction().add(...instructions);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = wallet.publicKey;

            const sig = await wallet.sendTransaction(tx, connection);
            await connection.confirmTransaction(sig, 'confirmed');
            await fetchProfiles();
        } catch (e) {
            console.error("Error deleting key:", e);
            alert("Failed to delete key. See console.");
        } finally {
            setProcessing(false);
        }
    };

    const openTransferModal = (profile: PlayerProfile) => {
        setSelectedProfile(profile);
        setTransferState({
            ...initialTransferState,
            step: 'enter_destination',
            originalAuthPubkey: wallet.publicKey?.toBase58() || '',
            profileKey: profile.key.toBase58(),
            profileCreatedAt: profile.data.createdAt.toNumber(),
            profileKeyThreshold: profile.data.keyThreshold,
        });
        setModalOpen(true);
    };

    const closeTransferModal = () => {
        const wasComplete = transferState.step === 'complete';
        setModalOpen(false);
        setSelectedProfile(null);
        setTransferState(initialTransferState);
        // Note: Profile refresh happens automatically via useEffect when 
        // isTransferInProgress becomes false (step goes back to 'idle')
        // This ensures we get the fresh fetchProfiles with updated closure
        if (wasComplete) {
            console.log("Transfer complete - profile refresh will happen automatically");
        }
    };

    const handleDestinationSubmit = () => {
        const dest = transferState.destinationPubkey.trim();
        
        // Validate destination address
        try {
            new PublicKey(dest);
        } catch {
            setTransferState(prev => ({ ...prev, error: 'Invalid Solana address' }));
            return;
        }

        if (dest === wallet.publicKey?.toBase58()) {
            setTransferState(prev => ({ ...prev, error: 'Destination cannot be the same as current wallet' }));
            return;
        }

        setTransferState(prev => ({ ...prev, step: 'sign_current', error: null }));
    };

    const handleRestartTransfer = () => {
        // Go back to sign_current step, clearing the old signed tx
        setTransferState(prev => ({
            ...prev,
            step: 'sign_current',
            partiallySignedTx: null,
            signedAt: null,
            error: null,
        }));
    };

    // Format time remaining as MM:SS
    const formatTimeRemaining = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    // Get timer color based on remaining time
    const getTimerColor = (seconds: number | null) => {
        if (seconds === null) return 'text-[var(--sa-text-dim)]';
        if (seconds <= 15) return 'text-red-400';
        if (seconds <= 30) return 'text-amber-400';
        return 'text-emerald-400';
    };

    const handleSignWithCurrentWallet = async () => {
        if (!wallet.publicKey || !wallet.signTransaction || !selectedProfile) return;
        setProcessing(true);
        
        try {
            const newAuthPubkey = new PublicKey(transferState.destinationPubkey);
            const asyncSigner = walletToAsyncSigner(wallet as any);
            
            const currentKeyIndex = selectedProfile.profileKeys.findIndex(k => 
                k.key.equals(wallet.publicKey!) && 
                ProfilePermissions.fromPermissions(k.permissions).auth
            );

            if (currentKeyIndex === -1) {
                throw new Error("Current wallet is not an auth key");
            }

            console.log("=== Building Transfer Auth Transaction ===");
            console.log("Profile:", selectedProfile.key.toBase58());
            console.log("Current auth key:", wallet.publicKey.toBase58());
            console.log("New auth key:", newAuthPubkey.toBase58());
            console.log("Current key index:", currentKeyIndex);

            const ixReturnFn = PlayerProfile.adjustAuth(
                program as any,
                [{
                    playerProfileProgram: program as any,
                    profile: selectedProfile,
                    key: asyncSigner
                }],
                [
                    (cont) => cont({
                        key: newAuthPubkey,
                        expireTime: null,
                        scope: new PublicKey(programId),
                        permissions: ProfilePermissions.auth()
                    })
                ],
                [currentKeyIndex, currentKeyIndex + 1],
                selectedProfile.data.keyThreshold,
            );

            const ixsWithSigners = await ixReturnFn(asyncSigner);
            const ixsWithSignersArray = Array.isArray(ixsWithSigners) ? ixsWithSigners : [ixsWithSigners];
            const instructions = ixsWithSignersArray.map(i => i.instruction);

            // Mark the destination key as a required signer in the instruction
            for (const ix of instructions) {
                const destKeyAccount = ix.keys.find(k => k.pubkey.equals(newAuthPubkey));
                if (destKeyAccount) {
                    destKeyAccount.isSigner = true;
                }
            }

            const tx = new Transaction().add(...instructions);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            // Destination wallet pays the transaction fee
            tx.feePayer = newAuthPubkey;

            console.log("Transaction built, requesting signature from current wallet...");
            console.log("Fee payer set to destination wallet:", newAuthPubkey.toBase58());
            
            // Sign with current wallet (partial sign)
            const signedTx = await wallet.signTransaction(tx);
            
            // Serialize and store
            const serialized = signedTx.serialize({ 
                requireAllSignatures: false,
                verifySignatures: false 
            });
            const base64Tx = serialized.toString('base64');
            
            console.log("Current wallet signed. Transaction serialized.");
            console.log("Partially signed tx (base64):", base64Tx.slice(0, 50) + "...");

            setTransferState(prev => ({
                ...prev,
                step: 'connect_destination',
                partiallySignedTx: base64Tx,
                signedAt: Date.now(),
                error: null,
            }));

        } catch (e) {
            console.error("Error signing with current wallet:", e);
            setTransferState(prev => ({
                ...prev,
                error: `Failed to sign: ${e instanceof Error ? e.message : String(e)}`
            }));
        } finally {
            setProcessing(false);
        }
    };

    const handleSignWithDestinationWallet = async () => {
        if (!wallet.publicKey || !wallet.signTransaction || !transferState.partiallySignedTx) return;
        
        // Verify correct wallet is connected
        if (wallet.publicKey.toBase58() !== transferState.destinationPubkey) {
            setTransferState(prev => ({
                ...prev,
                error: 'Please connect the destination wallet to continue'
            }));
            return;
        }

        setProcessing(true);
        
        try {
            console.log("=== Signing with Destination Wallet ===");
            console.log("Destination wallet:", wallet.publicKey.toBase58());

            // Deserialize the partially signed transaction
            const txBuffer = Buffer.from(transferState.partiallySignedTx, 'base64');
            const tx = Transaction.from(txBuffer);

            console.log("Transaction deserialized. Requesting signature from destination wallet...");

            // Sign with destination wallet
            const fullySignedTx = await wallet.signTransaction(tx);

            console.log("Destination wallet signed. Sending transaction...");

            // Send the fully signed transaction
            const signature = await connection.sendRawTransaction(fullySignedTx.serialize());
            
            console.log("Transaction sent:", signature);
            
            // Confirm
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            console.log("Transaction confirmed!");

            setTransferState(prev => ({ ...prev, step: 'complete', error: null }));

        } catch (e) {
            console.error("Error signing/sending with destination wallet:", e);
            setTransferState(prev => ({
                ...prev,
                error: `Failed: ${e instanceof Error ? e.message : String(e)}`
            }));
        } finally {
            setProcessing(false);
        }
    };

    const handleDisconnectAndReconnect = async () => {
        if (wallet.disconnect) {
            await wallet.disconnect();
            // Small delay then open wallet modal
            setTimeout(() => {
                setWalletModalVisible(true);
            }, 300);
        }
    };

    const handleOpenWalletModal = () => {
        setWalletModalVisible(true);
    };

    // Show transfer modal even if wallet is disconnected (during transfer flow)
    const showTransferModal = modalOpen && (
        transferState.step !== 'idle' || wallet.connected
    );

    // Determine if we should show the main content or "connect wallet" message
    const showConnectWalletMessage = !wallet.connected && !isTransferInProgress;

    if (showConnectWalletMessage) {
        return (
            <div className="container mx-auto px-6 py-20 text-center">
                <div className="sage-card p-12 max-w-md mx-auto">
                    <div className="w-16 h-16 mx-auto mb-6 border border-[var(--sa-border-light)] flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-[var(--sa-text-dim)]">
                            <path fillRule="evenodd" d="M12.516 2.17a.75.75 0 00-1.032 0 11.209 11.209 0 01-7.877 3.08.75.75 0 00-.722.515A12.74 12.74 0 002.5 9.75c0 5.992 3.043 11.294 7.923 14.07a.75.75 0 00.755 0C16.057 21.045 19.1 15.742 19.1 9.75c0-1.408-.255-2.766-.722-4.045a.75.75 0 00-.722-.515 11.208 11.208 0 01-7.877-3.08z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <h2 className="font-mono text-lg font-bold tracking-wider mb-3 text-[var(--sa-text)]">WALLET REQUIRED</h2>
                    <p className="font-mono text-xs text-[var(--sa-text-dim)] tracking-wide mb-6">
                        Connect your wallet to manage player profiles
                    </p>
                    <div className="h-[1px] bg-gradient-to-r from-transparent via-[var(--sa-border-light)] to-transparent mb-6"></div>
                    <p className="text-[var(--sa-text-dim)] text-sm">
                        Use the wallet button in the header to connect.
                    </p>
                </div>
            </div>
        );
    }

    if (loading && !isTransferInProgress) {
        return (
            <div className="container mx-auto px-6 py-20 text-center">
                <div className="sage-card p-12 max-w-md mx-auto">
                    <div className="w-12 h-12 mx-auto mb-6 border border-[var(--sa-accent)] flex items-center justify-center animate-pulse">
                        <div className="w-4 h-4 bg-[var(--sa-accent)]"></div>
                    </div>
                    <h2 className="font-mono text-sm font-bold tracking-wider text-[var(--sa-text-dim)]">LOADING PROFILES...</h2>
                </div>
            </div>
        );
    }

    const renderTransferModalContent = () => {
        switch (transferState.step) {
            case 'enter_destination':
                return (
                    <>
                        <div className="flex items-center gap-3 mb-6">
                            <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold tracking-wider">0001.</span>
                            <h3 className="font-mono text-lg font-bold tracking-wider text-[var(--sa-text)]">TRANSFER AUTHORITY</h3>
                        </div>
                        
                        {/* Step Progress Indicator */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-[var(--sa-black)] border border-[var(--sa-border)]">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-[var(--sa-accent)] bg-[rgb(var(--sa-accent-rgb-space))]/20 flex items-center justify-center">
                                    <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold">1</span>
                                </div>
                                <span className="font-mono text-[10px] text-[var(--sa-accent)] uppercase tracking-wider">Setup</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-[var(--sa-border)]"></div>
                            <div className="flex items-center gap-2 opacity-40">
                                <div className="w-6 h-6 border border-[var(--sa-border)] flex items-center justify-center">
                                    <span className="font-mono text-[10px] text-[var(--sa-text-dim)] font-bold">2</span>
                                </div>
                                <span className="font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider">Sign</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-[var(--sa-border)] opacity-40"></div>
                            <div className="flex items-center gap-2 opacity-40">
                                <div className="w-6 h-6 border border-[var(--sa-border)] flex items-center justify-center">
                                    <span className="font-mono text-[10px] text-[var(--sa-text-dim)] font-bold">3</span>
                                </div>
                                <span className="font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider">Complete</span>
                            </div>
                        </div>
                        
                        <div className="bg-amber-500/10 border border-amber-500/30 p-4 mb-6">
                            <p className="font-mono text-xs text-amber-300 tracking-wide">
                                <strong className="font-bold">⚠ IMPORTANT:</strong> You must own both wallets. The current auth key and the destination key must both sign this transaction.
                            </p>
                        </div>
                        <div className="mb-4">
                            <label className="block font-mono text-[10px] text-emerald-400 uppercase tracking-wider font-bold mb-2 flex items-center gap-2">
                                <span className="w-2 h-2 bg-emerald-400"></span>
                                Connected — Current Auth Key
                            </label>
                            <div className="sage-input bg-[var(--sa-dark)] border-emerald-500/30 text-emerald-400 break-all">
                                {transferState.originalAuthPubkey}
                            </div>
                        </div>
                        <div className="mb-6">
                            <label className="block font-mono text-[10px] text-[var(--sa-accent)] uppercase tracking-wider font-bold mb-2 flex items-center gap-2">
                                <span className="w-2 h-2 bg-[var(--sa-accent)] animate-pulse"></span>
                                Enter — New Auth Public Key (Destination)
                            </label>
                            <input 
                                type="text" 
                                value={transferState.destinationPubkey}
                                onChange={(e) => setTransferState(prev => ({ ...prev, destinationPubkey: e.target.value, error: null }))}
                                className="sage-input ring-2 ring-[rgb(var(--sa-accent-rgb-space))]/30"
                                placeholder="Enter destination Solana address..."
                            />
                        </div>
                        {transferState.error && (
                            <div className="bg-red-500/10 border border-red-500/30 p-3 mb-4">
                                <p className="font-mono text-xs text-red-400">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="sage-button-secondary px-5 py-2.5"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleDestinationSubmit}
                                disabled={!transferState.destinationPubkey.trim()}
                                className="sage-button disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Continue
                            </button>
                        </div>
                    </>
                );

            case 'sign_current':
                return (
                    <>
                        <div className="flex items-center gap-3 mb-6">
                            <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold tracking-wider">0002.</span>
                            <h3 className="font-mono text-lg font-bold tracking-wider text-[var(--sa-text)]">SIGN TRANSACTION</h3>
                        </div>
                        
                        {/* Step Progress Indicator */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-[var(--sa-black)] border border-[var(--sa-border)]">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-amber-500 bg-amber-500/20 flex items-center justify-center">
                                    <span className="font-mono text-[10px] text-amber-400 font-bold">1</span>
                                </div>
                                <span className="font-mono text-[10px] text-amber-400 uppercase tracking-wider">Sign Current</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-[var(--sa-border)]"></div>
                            <div className="flex items-center gap-2 opacity-40">
                                <div className="w-6 h-6 border border-[var(--sa-border)] flex items-center justify-center">
                                    <span className="font-mono text-[10px] text-[var(--sa-text-dim)] font-bold">2</span>
                                </div>
                                <span className="font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider">Sign Dest</span>
                            </div>
                        </div>
                        
                        <div className="bg-amber-500/10 border border-amber-500/30 p-4 mb-6">
                            <p className="font-mono text-xs text-amber-300 tracking-wide">
                                <strong>→ ACTION REQUIRED:</strong> Sign with your <strong>current auth wallet</strong> to authorize the transfer.
                            </p>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block font-mono text-[10px] text-amber-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <span className="w-2 h-2 bg-amber-400 animate-pulse"></span>
                                    SIGN NOW — Current Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-amber-500/50 text-amber-300 break-all ring-2 ring-amber-500/30">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div className="flex justify-center py-2">
                                <svg className="w-5 h-5 text-[var(--sa-text-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                                </svg>
                            </div>
                            <div>
                                <label className="block font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <span className="w-2 h-2 bg-[var(--sa-border)]"></span>
                                    PENDING — New Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] text-[var(--sa-text-dim)] break-all opacity-60">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        {transferState.error && (
                            <div className="bg-red-500/10 border border-red-500/30 p-3 mb-4">
                                <p className="font-mono text-xs text-red-400">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={() => setTransferState(prev => ({ ...prev, step: 'enter_destination', error: null }))}
                                className="sage-button-secondary px-5 py-2.5"
                                disabled={processing}
                            >
                                Back
                            </button>
                            <button 
                                onClick={handleSignWithCurrentWallet}
                                disabled={processing}
                                className="sage-button disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {processing ? 'SIGNING...' : 'SIGN WITH CURRENT WALLET'}
                            </button>
                        </div>
                    </>
                );

            case 'connect_destination':
                const isWalletConnected = wallet.connected;
                const isCorrectWallet = wallet.publicKey?.toBase58() === transferState.destinationPubkey;
                const isOriginalWallet = wallet.publicKey?.toBase58() === transferState.originalAuthPubkey;

                return (
                    <>
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                                <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold tracking-wider">0003.</span>
                                <h3 className="font-mono text-lg font-bold tracking-wider text-[var(--sa-text)]">CONNECT DESTINATION</h3>
                            </div>
                            {/* Countdown Timer */}
                            {timeRemaining !== null && (
                                <div className={`flex items-center gap-2 px-3 py-1.5 border ${
                                    timeRemaining <= 15 ? 'bg-red-500/10 border-red-500/30' :
                                    timeRemaining <= 30 ? 'bg-amber-500/10 border-amber-500/30' :
                                    'bg-[var(--sa-dark)] border-[var(--sa-border)]'
                                }`}>
                                    <svg className={`w-4 h-4 ${getTimerColor(timeRemaining)}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <span className={`font-mono text-sm font-bold ${getTimerColor(timeRemaining)}`}>
                                        {formatTimeRemaining(timeRemaining)}
                                    </span>
                                </div>
                            )}
                        </div>
                        
                        {/* Step Progress Indicator */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-[var(--sa-black)] border border-[var(--sa-border)]">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                                <span className="font-mono text-[10px] text-emerald-400 uppercase tracking-wider">Signed</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-emerald-500/30"></div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-amber-500 bg-amber-500/20 flex items-center justify-center animate-pulse">
                                    <span className="font-mono text-[10px] text-amber-400 font-bold">2</span>
                                </div>
                                <span className="font-mono text-[10px] text-amber-400 uppercase tracking-wider">Connect & Sign</span>
                            </div>
                        </div>
                        
                        {/* Success checkmark for first signature */}
                        <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 mb-4">
                            <div className="flex items-center gap-2 text-emerald-400">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span className="font-mono text-xs font-bold tracking-wider">FIRST SIGNATURE COMPLETE</span>
                            </div>
                        </div>

                        {/* Time warning */}
                        {timeRemaining !== null && timeRemaining <= 30 && (
                            <div className={`${timeRemaining <= 15 ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'} border p-3 mb-4`}>
                                <p className={`font-mono text-xs ${timeRemaining <= 15 ? 'text-red-400' : 'text-amber-400'}`}>
                                    <strong>⚠ {timeRemaining <= 15 ? 'HURRY!' : 'TIME RUNNING LOW!'}</strong> Complete within {formatTimeRemaining(timeRemaining)}
                                </p>
                            </div>
                        )}

                        <div className="bg-amber-500/10 border border-amber-500/30 p-4 mb-6">
                            <p className="font-mono text-xs text-amber-300 tracking-wide">
                                <strong>→ ACTION REQUIRED:</strong> Connect the <strong>destination wallet</strong> to add the second signature.
                            </p>
                        </div>

                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block font-mono text-[10px] text-emerald-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    SIGNED — Original Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-emerald-500/50 text-emerald-400 text-xs break-all py-2">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div className="flex justify-center py-1">
                                <svg className="w-5 h-5 text-[var(--sa-text-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                                </svg>
                            </div>
                            <div>
                                <label className="block font-mono text-[10px] text-amber-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <span className="w-2 h-2 bg-amber-400 animate-pulse"></span>
                                    AWAITING — Destination Wallet
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-amber-500/50 text-amber-300 text-xs break-all py-2 ring-2 ring-amber-500/30">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>

                        {/* Current wallet status */}
                        <div className="mb-4 p-3 bg-[var(--sa-dark)] border border-[var(--sa-border)]">
                            <p className="font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider mb-2">Current Connection</p>
                            {isWalletConnected ? (
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 ${isCorrectWallet ? 'bg-emerald-400' : isOriginalWallet ? 'bg-amber-400' : 'bg-red-400'}`}></span>
                                        <p className={`font-mono text-xs break-all ${isCorrectWallet ? 'text-emerald-400' : isOriginalWallet ? 'text-amber-400' : 'text-red-400'}`}>
                                            {wallet.publicKey?.toBase58()}
                                        </p>
                                    </div>
                                    {isCorrectWallet && (
                                        <span className="ml-2 font-mono text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 border border-emerald-500/30 whitespace-nowrap">
                                            READY
                                        </span>
                                    )}
                                    {isOriginalWallet && (
                                        <span className="ml-2 font-mono text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 border border-amber-500/30 whitespace-nowrap">
                                            ORIGINAL
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <p className="font-mono text-xs text-[var(--sa-text-dim)]">No wallet connected</p>
                            )}
                        </div>

                        {transferState.error && (
                            <div className="bg-red-500/10 border border-red-500/30 p-3 mb-4">
                                <p className="font-mono text-xs text-red-400">{transferState.error}</p>
                            </div>
                        )}

                        <div className="flex justify-between gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="sage-button-secondary px-5 py-2.5"
                            >
                                Cancel
                            </button>
                            <div className="flex gap-2">
                                {isWalletConnected && !isCorrectWallet && (
                                    <button 
                                        onClick={handleDisconnectAndReconnect}
                                        className="sage-button-secondary px-5 py-2.5"
                                    >
                                        SWITCH WALLET
                                    </button>
                                )}
                                {!isWalletConnected && (
                                    <button 
                                        onClick={handleOpenWalletModal}
                                        className="sage-button"
                                    >
                                        CONNECT WALLET
                                    </button>
                                )}
                                {isCorrectWallet && (
                                    <button 
                                        onClick={() => setTransferState(prev => ({ ...prev, step: 'sign_destination' }))}
                                        className="sage-button !bg-emerald-500 !border-emerald-500 hover:!bg-emerald-400"
                                    >
                                        CONTINUE TO SIGN
                                    </button>
                                )}
                            </div>
                        </div>
                    </>
                );

            case 'sign_destination':
                return (
                    <>
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                                <span className="font-mono text-[10px] text-emerald-400 font-bold tracking-wider">FINAL</span>
                                <h3 className="font-mono text-lg font-bold tracking-wider text-[var(--sa-text)]">COMPLETE TRANSFER</h3>
                            </div>
                            {/* Countdown Timer */}
                            {timeRemaining !== null && (
                                <div className={`flex items-center gap-2 px-3 py-1.5 border ${
                                    timeRemaining <= 15 ? 'bg-red-500/10 border-red-500/30' :
                                    timeRemaining <= 30 ? 'bg-amber-500/10 border-amber-500/30' :
                                    'bg-[var(--sa-dark)] border-[var(--sa-border)]'
                                }`}>
                                    <svg className={`w-4 h-4 ${getTimerColor(timeRemaining)}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <span className={`font-mono text-sm font-bold ${getTimerColor(timeRemaining)}`}>
                                        {formatTimeRemaining(timeRemaining)}
                                    </span>
                                </div>
                            )}
                        </div>
                        
                        {/* Step Progress Indicator - Both steps complete! */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-[var(--sa-black)] border border-emerald-500/30">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                                <span className="font-mono text-[10px] text-emerald-400 uppercase tracking-wider">Signed</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-emerald-500/50"></div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                                <span className="font-mono text-[10px] text-emerald-400 uppercase tracking-wider">Connected</span>
                            </div>
                        </div>

                        {/* Time warning */}
                        {timeRemaining !== null && timeRemaining <= 30 && (
                            <div className={`${timeRemaining <= 15 ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'} border p-3 mb-4`}>
                                <p className={`font-mono text-xs ${timeRemaining <= 15 ? 'text-red-400' : 'text-amber-400'}`}>
                                    <strong>⚠ {timeRemaining <= 15 ? 'HURRY!' : 'TIME RUNNING LOW!'}</strong> Sign now - only {formatTimeRemaining(timeRemaining)} remaining!
                                </p>
                            </div>
                        )}

                        <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 mb-6">
                            <div className="flex items-center gap-2 text-emerald-400">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <p className="font-mono text-xs tracking-wide">
                                    <strong>DESTINATION WALLET CONNECTED!</strong> Sign to complete the authority transfer.
                                </p>
                            </div>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block font-mono text-[10px] text-emerald-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    SIGNED — Original Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-emerald-500/50 text-emerald-400 text-xs break-all py-2">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div className="flex justify-center py-1">
                                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                                </svg>
                            </div>
                            <div>
                                <label className="block font-mono text-[10px] text-emerald-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    CONNECTED — Ready to Sign
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-emerald-500/50 text-emerald-400 text-xs break-all py-2 ring-2 ring-emerald-500/30">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        {transferState.error && (
                            <div className="bg-red-500/10 border border-red-500/30 p-3 mb-4">
                                <p className="font-mono text-xs text-red-400">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="sage-button-secondary px-5 py-2.5"
                                disabled={processing}
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleSignWithDestinationWallet}
                                disabled={processing}
                                className="sage-button !bg-emerald-500 !border-emerald-500 hover:!bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {processing ? 'PROCESSING...' : 'SIGN & COMPLETE TRANSFER'}
                            </button>
                        </div>
                    </>
                );

            case 'complete':
                return (
                    <>
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-8 h-8 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <h3 className="font-mono text-lg font-bold tracking-wider text-emerald-400">TRANSFER COMPLETE</h3>
                        </div>
                        
                        {/* All Steps Complete */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-emerald-500/10 border border-emerald-500/30">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                            </div>
                            <div className="flex-1 h-[1px] bg-emerald-500/50"></div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                            </div>
                            <div className="flex-1 h-[1px] bg-emerald-500/50"></div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                            </div>
                        </div>
                        
                        <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 mb-6">
                            <div className="flex items-center gap-2 text-emerald-400">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <p className="font-mono text-xs tracking-wide">
                                    Authority has been successfully transferred to the new wallet.
                                </p>
                            </div>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block font-mono text-[10px] text-red-400/70 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                    REMOVED — Previous Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-red-500/20 text-red-400/50 text-xs break-all py-2 line-through">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div className="flex justify-center py-1">
                                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                                </svg>
                            </div>
                            <div>
                                <label className="block font-mono text-[10px] text-emerald-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    ACTIVE — New Auth Key
                                </label>
                                <div className="sage-input bg-[var(--sa-dark)] border-emerald-500/50 text-emerald-400 text-xs break-all py-2 ring-2 ring-emerald-500/30">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <button 
                                onClick={closeTransferModal}
                                className="sage-button !bg-emerald-500 !border-emerald-500 hover:!bg-emerald-400"
                            >
                                DONE
                            </button>
                        </div>
                    </>
                );

            case 'expired':
                return (
                    <>
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-8 h-8 border-2 border-red-500 bg-red-500/20 flex items-center justify-center">
                                <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                            </div>
                            <h3 className="font-mono text-lg font-bold tracking-wider text-red-400">TRANSACTION EXPIRED</h3>
                        </div>
                        
                        {/* Failed Progress Indicator */}
                        <div className="flex items-center gap-2 mb-6 p-3 bg-[var(--sa-black)] border border-red-500/30">
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-emerald-500 bg-emerald-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                                <span className="font-mono text-[10px] text-emerald-400 uppercase tracking-wider">Signed</span>
                            </div>
                            <div className="flex-1 h-[1px] bg-red-500/30"></div>
                            <div className="flex items-center gap-2">
                                <div className="w-6 h-6 border-2 border-red-500 bg-red-500/20 flex items-center justify-center">
                                    <svg className="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </div>
                                <span className="font-mono text-[10px] text-red-400 uppercase tracking-wider">Expired</span>
                            </div>
                        </div>
                        
                        <div className="bg-red-500/10 border border-red-500/30 p-4 mb-4">
                            <div className="flex items-center gap-2 text-red-400">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <p className="font-mono text-xs tracking-wide">
                                    The transaction blockhash has expired. Solana transactions are only valid for approximately 90 seconds.
                                </p>
                            </div>
                        </div>
                        <div className="bg-[var(--sa-dark)] border border-[var(--sa-border)] p-4 mb-6">
                            <div className="flex items-center gap-2 text-[var(--sa-text-dim)]">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <p className="font-mono text-xs tracking-wide">
                                    Don't worry - no changes were made to your profile. You can restart the transfer process.
                                </p>
                            </div>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider mb-1">From (Current Auth)</label>
                                <div className="sage-input bg-[var(--sa-dark)] text-[var(--sa-text-dim)] text-xs break-all py-2 opacity-60">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div>
                                <label className="block font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider mb-1">To (Destination)</label>
                                <div className="sage-input bg-[var(--sa-dark)] text-[var(--sa-text-dim)] text-xs break-all py-2 opacity-60">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-between gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="sage-button-secondary px-5 py-2.5"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleRestartTransfer}
                                className="sage-button"
                            >
                                RESTART TRANSFER
                            </button>
                        </div>
                    </>
                );

            default:
                return null;
        }
    };

    return (
        <div className="container mx-auto px-6">
            {/* Section Header */}
            <div className="section-header">
                <span className="section-number">0001.</span>
                <h2 className="section-title">MY PLAYER PROFILES</h2>
                <div className="section-line"></div>
            </div>

            {/* Show transfer in progress banner if disconnected during transfer */}
            {isTransferInProgress && !wallet.connected && (
                <div className="sage-card bg-amber-500/10 border-amber-500/30 p-4 mb-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="font-mono text-sm font-bold text-amber-400 tracking-wider">TRANSFER IN PROGRESS</p>
                            <p className="font-mono text-xs text-amber-400/70 mt-1">Connect the destination wallet to complete the transfer.</p>
                        </div>
                        <button 
                            onClick={handleOpenWalletModal}
                            className="sage-button !bg-amber-500 !border-amber-500"
                        >
                            CONNECT WALLET
                        </button>
                    </div>
                </div>
            )}

            {/* Program ID Configuration - Compact */}
            {!isTransferInProgress && (
                <div className="sage-card p-4 mb-4">
                    <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                        <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold tracking-wider">CONFIG</span>
                            <span className="font-mono text-[10px] text-[var(--sa-text-dim)] uppercase tracking-wider">Program ID:</span>
                        </div>
                        <div className="flex-1 flex flex-col sm:flex-row gap-2">
                            <input
                                type="text"
                                value={programId}
                                onChange={(e) => setProgramId(e.target.value)}
                                className="sage-input flex-1 py-2 text-[11px]"
                                placeholder="Enter program ID..."
                            />
                            <div className="flex gap-2 flex-wrap">
                                <button
                                    onClick={fetchProfiles}
                                    disabled={loading}
                                    className="sage-button py-2 px-4 disabled:opacity-50"
                                >
                                    {loading ? 'SEARCHING...' : 'SEARCH'}
                                </button>
                                {KNOWN_PROGRAM_IDS.map((id) => (
                                    <button
                                        key={id}
                                        onClick={() => setProgramId(id)}
                                        className="sage-button-secondary px-3 py-2 font-mono text-[10px]"
                                    >
                                        {id.slice(0, 6)}...
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    {debugInfo && (
                        <div className="mt-2 bg-[var(--sa-black)] border border-[var(--sa-border)] px-3 py-2">
                            <p className="font-mono text-[11px] text-[var(--sa-text-dim)]">{debugInfo}</p>
                        </div>
                    )}
                </div>
            )}

            {!isTransferInProgress && profiles.length === 0 ? (
                <div className="sage-card p-8 text-center">
                    <p className="font-mono text-sm text-[var(--sa-text-dim)] tracking-wide">No profiles found for this wallet.</p>
                </div>
            ) : !isTransferInProgress && (
                <div className="grid gap-4">
                    {profiles.map((profile, profileIndex) => (
                        <div key={profile.key.toBase58()} className="sage-card overflow-hidden animate-fade-in-up" style={{ animationDelay: `${profileIndex * 0.1}s` }}>
                            {/* Card Header - Compact with inline info */}
                            <div className="bg-[var(--sa-black)] border-b border-[var(--sa-border)] px-4 py-2.5 flex items-center justify-between">
                                <div className="flex items-center gap-4 flex-wrap">
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-[10px] text-[var(--sa-accent)] font-bold tracking-wider">
                                            {String(profileIndex + 1).padStart(4, '0')}.
                                        </span>
                                        <span className="font-mono text-xs font-bold tracking-wider text-[var(--sa-text)]">PROFILE</span>
                                    </div>
                                    <div className="h-3 w-[1px] bg-[var(--sa-border)] hidden sm:block"></div>
                                    {/* Profile Username - Prominent Display */}
                                    {profileNames.get(profile.key.toBase58()) ? (
                                        <span className="font-display text-base sm:text-lg font-bold tracking-wide bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-amber-400 bg-clip-text text-transparent drop-shadow-[0_0_12px_rgba(34,211,238,0.4)]">
                                            {profileNames.get(profile.key.toBase58())}
                                        </span>
                                    ) : (
                                        <span className="font-mono text-xs italic text-[var(--sa-text-dim)]/60 px-2 py-0.5 border border-dashed border-[var(--sa-border)] bg-[var(--sa-dark)]/50">
                                            « No Name Set »
                                        </span>
                                    )}
                                    <div className="h-3 w-[1px] bg-[var(--sa-border)] hidden lg:block"></div>
                                    <span className="font-mono text-xs text-cyan-400 break-all hidden lg:block font-semibold tracking-wide">{profile.key.toBase58()}</span>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="hidden md:flex items-center gap-4 text-[var(--sa-text-dim)]">
                                        <span className="font-mono text-[10px]">Created: <span className="text-[var(--sa-text)]">{new Date(profile.data.createdAt.toNumber() * 1000).toLocaleDateString()}</span></span>
                                        <span className="font-mono text-[10px]">Threshold: <span className="text-[var(--sa-text)]">{profile.data.keyThreshold}</span></span>
                                    </div>
                                    <div className="status-indicator active"></div>
                                </div>
                            </div>
                            
                            {/* Mobile-only profile info */}
                            <div className="lg:hidden px-4 py-2 bg-[var(--sa-dark)] border-b border-[var(--sa-border)]">
                                <span className="font-mono text-xs text-cyan-400 break-all font-semibold tracking-wide">{profile.key.toBase58()}</span>
                            </div>

                            {/* Keys Table - Compact */}
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead className="bg-[var(--sa-dark)]">
                                        <tr>
                                            <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--sa-text-dim)] font-bold">Key</th>
                                            <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--sa-text-dim)] font-bold">Permissions</th>
                                            <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--sa-text-dim)] font-bold">Expiry</th>
                                            <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--sa-text-dim)] font-bold text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[var(--sa-border)]">
                                        {profile.profileKeys.map((pk, idx) => {
                                            const perms = ProfilePermissions.fromPermissions(pk.permissions);
                                            const isAuth = perms.auth;
                                            const isMe = wallet.publicKey && pk.key.equals(wallet.publicKey);

                                            return (
                                                <tr key={`${profile.key.toBase58()}-${idx}`} className="hover:bg-[rgb(var(--sa-accent-rgb-space))]/5 transition-colors">
                                                    <td className="px-4 py-2 font-mono text-[11px] text-[var(--sa-text)]">
                                                        <div className="flex items-center gap-2">
                                                            <span 
                                                                className="cursor-help hover:text-cyan-400 transition-colors" 
                                                                title={pk.key.toBase58()}
                                                            >
                                                                {pk.key.toBase58().slice(0, 4)}...{pk.key.toBase58().slice(-4)}
                                                            </span>
                                                            {isMe && (
                                                                <span className="font-mono text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 border border-emerald-500/30 whitespace-nowrap">
                                                                    YOU
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <div className="flex flex-wrap gap-1">
                                                            {isAuth && (
                                                                <span className="font-mono text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 border border-red-500/30">AUTH</span>
                                                                )}
                                                                {perms.addKeys && (
                                                                    <span className="font-mono text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 border border-blue-500/30">ADD</span>
                                                                )}
                                                                {perms.removeKeys && (
                                                                    <span className="font-mono text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 border border-amber-500/30">RM</span>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2 font-mono text-[11px] text-[var(--sa-text-dim)]">
                                                            {pk.expireTime.lt(new BN(0)) ? 'Never' : new Date(pk.expireTime.toNumber() * 1000).toLocaleDateString()}
                                                        </td>
                                                        <td className="px-3 py-2 text-right">
                                                            {isAuth && isMe ? (
                                                                <button 
                                                                    onClick={() => openTransferModal(profile)}
                                                                    className="font-mono text-[10px] text-[var(--sa-accent)] hover:text-[var(--sa-accent-hover)] uppercase font-bold tracking-wider disabled:opacity-50 transition-colors"
                                                                    disabled={processing}
                                                                >
                                                                    TRANSFER
                                                                </button>
                                                            ) : (
                                                                !isAuth && (
                                                                    <button 
                                                                        onClick={() => handleDeleteKey(profile, idx)}
                                                                        className="font-mono text-[10px] text-red-400 hover:text-red-300 uppercase font-bold tracking-wider disabled:opacity-50 transition-colors"
                                                                        disabled={processing}
                                                                    >
                                                                        DELETE
                                                                    </button>
                                                                )
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Transfer Modal */}
            {showTransferModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="sage-card p-6 max-w-lg w-full border-[rgb(var(--sa-accent-rgb-space))]/30">
                        {renderTransferModalContent()}
                    </div>
                </div>
            )}
        </div>
    );
};
