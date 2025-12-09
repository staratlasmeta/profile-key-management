import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, BN } from '@staratlas/anchor';
import {
    PlayerProfile,
    PlayerProfileProgram,
    ProfilePermissions
} from '@staratlas/player-profile';
import { walletToAsyncSigner, readAllFromRPC } from '@staratlas/data-source';
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

            console.log("Program exists, checking for accounts...");

            const allAccounts = await connection.getProgramAccounts(new PublicKey(programId), {
                commitment: 'confirmed'
            });
            console.log("Total accounts owned by program:", allAccounts.length);

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
            setDebugInfo(`Found ${myProfiles.length} profiles. Program has ${allAccounts.length} total accounts.`);

            if (myProfiles.length === 0 && allAccounts.length > 0) {
                setDebugInfo(`Found ${myProfiles.length} profiles. Program has ${allAccounts.length} total accounts. The offset calculation might be wrong or your wallet is not an auth key on any profiles.`);
            }

            setProfiles(myProfiles);
        } catch (e) {
            console.error("Error fetching profiles:", e);
            setDebugInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setLoading(false);
        }
    }, [connection, wallet.publicKey, program, programId, isTransferInProgress]);

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
        if (seconds === null) return 'text-gray-400';
        if (seconds <= 15) return 'text-red-400';
        if (seconds <= 30) return 'text-amber-400';
        return 'text-green-400';
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
        return <div className="text-center text-gray-500 mt-10">Please connect your wallet to manage profiles.</div>;
    }

    if (loading && !isTransferInProgress) {
        return <div className="text-center mt-10 text-gray-300">Loading profiles...</div>;
    }

    const renderTransferModalContent = () => {
        switch (transferState.step) {
            case 'enter_destination':
                return (
                    <>
                        <h3 className="text-xl font-bold text-white mb-4">Transfer Authority - Step 1 of 3</h3>
                        <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg p-4 mb-6">
                            <p className="text-amber-200 text-sm">
                                <strong className="font-bold">Important:</strong> You must own both wallets. The current auth key and the destination key must both sign this transaction.
                            </p>
                        </div>
                        <div className="mb-4">
                            <label className="block text-gray-400 text-xs uppercase font-bold mb-2">Current Auth Key</label>
                            <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-gray-400 font-mono text-sm break-all">
                                {transferState.originalAuthPubkey}
                            </div>
                        </div>
                        <div className="mb-6">
                            <label className="block text-gray-400 text-xs uppercase font-bold mb-2">New Auth Public Key (Destination)</label>
                            <input 
                                type="text" 
                                value={transferState.destinationPubkey}
                                onChange={(e) => setTransferState(prev => ({ ...prev, destinationPubkey: e.target.value, error: null }))}
                                className="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono text-sm"
                                placeholder="Enter destination Solana address..."
                            />
                        </div>
                        {transferState.error && (
                            <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4">
                                <p className="text-red-300 text-sm">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="px-4 py-2 text-gray-300 hover:text-white text-sm font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleDestinationSubmit}
                                disabled={!transferState.destinationPubkey.trim()}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold transition-all"
                            >
                                Continue
                            </button>
                        </div>
                    </>
                );

            case 'sign_current':
                return (
                    <>
                        <h3 className="text-xl font-bold text-white mb-4">Transfer Authority - Step 2 of 3</h3>
                        <div className="bg-blue-900/30 border border-blue-700/50 rounded-lg p-4 mb-6">
                            <p className="text-blue-200 text-sm">
                                Sign with your <strong>current auth wallet</strong> to authorize the transfer.
                            </p>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">From (Current Auth)</label>
                                <div className="bg-gray-900 border border-green-700/50 rounded-lg p-3 text-green-400 font-mono text-sm break-all">
                                    ✓ {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div className="flex justify-center">
                                <span className="text-gray-500">↓</span>
                            </div>
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">To (New Auth)</label>
                                <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-gray-300 font-mono text-sm break-all">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        {transferState.error && (
                            <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4">
                                <p className="text-red-300 text-sm">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={() => setTransferState(prev => ({ ...prev, step: 'enter_destination', error: null }))}
                                className="px-4 py-2 text-gray-300 hover:text-white text-sm font-semibold transition-colors"
                                disabled={processing}
                            >
                                Back
                            </button>
                            <button 
                                onClick={handleSignWithCurrentWallet}
                                disabled={processing}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold transition-all"
                            >
                                {processing ? 'Signing...' : 'Sign with Current Wallet'}
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
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-xl font-bold text-white">Transfer Authority - Step 3 of 3</h3>
                            {/* Countdown Timer */}
                            {timeRemaining !== null && (
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                                    timeRemaining <= 15 ? 'bg-red-900/30 border border-red-700' :
                                    timeRemaining <= 30 ? 'bg-amber-900/30 border border-amber-700' :
                                    'bg-gray-900 border border-gray-700'
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
                        
                        {/* Success checkmark for first signature */}
                        <div className="bg-green-900/20 border border-green-700/50 rounded-lg p-4 mb-4">
                            <div className="flex items-center gap-2 text-green-400">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span className="text-sm font-medium">First signature complete!</span>
                            </div>
                        </div>

                        {/* Time warning */}
                        {timeRemaining !== null && timeRemaining <= 30 && (
                            <div className={`${timeRemaining <= 15 ? 'bg-red-900/30 border-red-700' : 'bg-amber-900/30 border-amber-700'} border rounded-lg p-3 mb-4`}>
                                <p className={`text-sm ${timeRemaining <= 15 ? 'text-red-200' : 'text-amber-200'}`}>
                                    <strong>⚠️ {timeRemaining <= 15 ? 'Hurry!' : 'Time running low!'}</strong> Complete the second signature within {formatTimeRemaining(timeRemaining)} or you'll need to restart.
                                </p>
                            </div>
                        )}

                        <div className="bg-blue-900/30 border border-blue-700/50 rounded-lg p-4 mb-6">
                            <p className="text-blue-200 text-sm">
                                Now connect the <strong>destination wallet</strong> to add the second signature and complete the transfer.
                            </p>
                        </div>

                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">✓ Signed by original auth</label>
                                <div className="bg-gray-900 border border-green-700/50 rounded-lg p-2 text-green-400 font-mono text-xs break-all">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">⏳ Awaiting signature from</label>
                                <div className="bg-gray-900 border border-amber-700/50 rounded-lg p-2 text-amber-400 font-mono text-xs break-all">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>

                        {/* Current wallet status */}
                        <div className="mb-4 p-3 bg-gray-900/50 rounded-lg border border-gray-700">
                            <p className="text-gray-500 text-xs uppercase mb-2">Current Connection Status</p>
                            {isWalletConnected ? (
                                <div className="flex items-center justify-between">
                                    <p className={`font-mono text-sm break-all ${isCorrectWallet ? 'text-green-400' : 'text-amber-400'}`}>
                                        {wallet.publicKey?.toBase58()}
                                    </p>
                                    {isCorrectWallet && (
                                        <span className="ml-2 text-xs bg-green-900 text-green-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                                            Ready!
                                        </span>
                                    )}
                                    {isOriginalWallet && (
                                        <span className="ml-2 text-xs bg-amber-900 text-amber-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                                            Original
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <p className="text-gray-500 text-sm">No wallet connected</p>
                            )}
                        </div>

                        {transferState.error && (
                            <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4">
                                <p className="text-red-300 text-sm">{transferState.error}</p>
                            </div>
                        )}

                        <div className="flex justify-between gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="px-4 py-2 text-gray-300 hover:text-white text-sm font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <div className="flex gap-2">
                                {isWalletConnected && !isCorrectWallet && (
                                    <button 
                                        onClick={handleDisconnectAndReconnect}
                                        className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500 text-sm font-semibold transition-all"
                                    >
                                        Switch Wallet
                                    </button>
                                )}
                                {!isWalletConnected && (
                                    <button 
                                        onClick={handleOpenWalletModal}
                                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold transition-all"
                                    >
                                        Connect Wallet
                                    </button>
                                )}
                                {isCorrectWallet && (
                                    <button 
                                        onClick={() => setTransferState(prev => ({ ...prev, step: 'sign_destination' }))}
                                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold transition-all"
                                    >
                                        Continue to Sign
                                    </button>
                                )}
                            </div>
                        </div>
                    </>
                );

            case 'sign_destination':
                return (
                    <>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-xl font-bold text-white">Transfer Authority - Final Step</h3>
                            {/* Countdown Timer */}
                            {timeRemaining !== null && (
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                                    timeRemaining <= 15 ? 'bg-red-900/30 border border-red-700' :
                                    timeRemaining <= 30 ? 'bg-amber-900/30 border border-amber-700' :
                                    'bg-gray-900 border border-gray-700'
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

                        {/* Time warning */}
                        {timeRemaining !== null && timeRemaining <= 30 && (
                            <div className={`${timeRemaining <= 15 ? 'bg-red-900/30 border-red-700' : 'bg-amber-900/30 border-amber-700'} border rounded-lg p-3 mb-4`}>
                                <p className={`text-sm ${timeRemaining <= 15 ? 'text-red-200' : 'text-amber-200'}`}>
                                    <strong>⚠️ {timeRemaining <= 15 ? 'Hurry!' : 'Time running low!'}</strong> Sign now - only {formatTimeRemaining(timeRemaining)} remaining!
                                </p>
                            </div>
                        )}

                        <div className="bg-green-900/30 border border-green-700/50 rounded-lg p-4 mb-6">
                            <p className="text-green-200 text-sm">
                                <strong>Destination wallet connected!</strong> Sign to complete the authority transfer.
                            </p>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">✓ Signed by original auth</label>
                                <div className="bg-gray-900 border border-green-700/50 rounded-lg p-2 text-green-400 font-mono text-xs break-all">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">✓ Ready to sign with destination</label>
                                <div className="bg-gray-900 border border-green-700/50 rounded-lg p-2 text-green-400 font-mono text-xs break-all">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        {transferState.error && (
                            <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 mb-4">
                                <p className="text-red-300 text-sm">{transferState.error}</p>
                            </div>
                        )}
                        <div className="flex justify-end gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="px-4 py-2 text-gray-300 hover:text-white text-sm font-semibold transition-colors"
                                disabled={processing}
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleSignWithDestinationWallet}
                                disabled={processing}
                                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold transition-all"
                            >
                                {processing ? 'Processing...' : 'Sign & Complete Transfer'}
                            </button>
                        </div>
                    </>
                );

            case 'complete':
                return (
                    <>
                        <h3 className="text-xl font-bold text-white mb-4">Transfer Complete! 🎉</h3>
                        <div className="bg-green-900/30 border border-green-700/50 rounded-lg p-4 mb-6">
                            <p className="text-green-200 text-sm">
                                Authority has been successfully transferred to the new wallet.
                            </p>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">Previous Auth (removed)</label>
                                <div className="bg-gray-900 border border-gray-700 rounded-lg p-2 text-gray-500 font-mono text-xs break-all line-through">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">New Auth (active)</label>
                                <div className="bg-gray-900 border border-green-700/50 rounded-lg p-2 text-green-400 font-mono text-xs break-all">
                                    ✓ {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <button 
                                onClick={closeTransferModal}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold transition-all"
                            >
                                Done
                            </button>
                        </div>
                    </>
                );

            case 'expired':
                return (
                    <>
                        <h3 className="text-xl font-bold text-white mb-4">Transaction Expired ⏰</h3>
                        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 mb-6">
                            <p className="text-red-200 text-sm">
                                The transaction blockhash has expired. Solana transactions are only valid for approximately 90 seconds after the blockhash is obtained.
                            </p>
                        </div>
                        <div className="bg-gray-900/50 border border-gray-700 rounded-lg p-4 mb-6">
                            <p className="text-gray-300 text-sm">
                                Don't worry - no changes were made to your profile. You can restart the transfer process to try again.
                            </p>
                        </div>
                        <div className="space-y-3 mb-6">
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">From (Current Auth)</label>
                                <div className="bg-gray-900 border border-gray-700 rounded-lg p-2 text-gray-400 font-mono text-xs break-all">
                                    {transferState.originalAuthPubkey}
                                </div>
                            </div>
                            <div>
                                <label className="block text-gray-500 text-xs uppercase mb-1">To (Destination)</label>
                                <div className="bg-gray-900 border border-gray-700 rounded-lg p-2 text-gray-400 font-mono text-xs break-all">
                                    {transferState.destinationPubkey}
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-between gap-3">
                            <button 
                                onClick={closeTransferModal}
                                className="px-4 py-2 text-gray-300 hover:text-white text-sm font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleRestartTransfer}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold transition-all"
                            >
                                Restart Transfer
                            </button>
                        </div>
                    </>
                );

            default:
                return null;
        }
    };

    return (
        <div className="container mx-auto p-4">
            <h2 className="text-2xl font-bold mb-6 text-white">My Player Profiles</h2>

            {/* Show transfer in progress banner if disconnected during transfer */}
            {isTransferInProgress && !wallet.connected && (
                <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4 mb-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-amber-200 font-semibold">Transfer in Progress</p>
                            <p className="text-amber-300/70 text-sm">Connect the destination wallet to complete the transfer.</p>
                        </div>
                        <button 
                            onClick={handleOpenWalletModal}
                            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-semibold transition-all"
                        >
                            Connect Wallet
                        </button>
                    </div>
                </div>
            )}

            {/* Program ID Configuration */}
            {!isTransferInProgress && (
                <div className="bg-gray-800 rounded-lg p-4 mb-6 border border-gray-700">
                    <h3 className="text-lg font-semibold text-white mb-3">Program Configuration</h3>
                    <div className="space-y-3">
                        <div>
                            <label className="block text-gray-400 text-sm mb-1">Player Profile Program ID</label>
                            <input
                                type="text"
                                value={programId}
                                onChange={(e) => setProgramId(e.target.value)}
                                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-white font-mono text-sm"
                                placeholder="Enter program ID..."
                            />
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            <button
                                onClick={fetchProfiles}
                                disabled={loading}
                                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
                            >
                                {loading ? 'Searching...' : 'Search Profiles'}
                            </button>
                            {KNOWN_PROGRAM_IDS.map((id) => (
                                <button
                                    key={id}
                                    onClick={() => setProgramId(id)}
                                    className="px-3 py-2 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 text-sm font-mono"
                                >
                                    {id.slice(0, 8)}...
                                </button>
                            ))}
                        </div>
                        {debugInfo && (
                            <div className="bg-gray-900 border border-gray-600 rounded p-3">
                                <p className="text-gray-300 text-sm font-mono">{debugInfo}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {!isTransferInProgress && profiles.length === 0 ? (
                <p className="text-gray-400">No profiles found for this wallet.</p>
            ) : !isTransferInProgress && (
                <div className="grid gap-6">
                    {profiles.map((profile) => (
                        <div key={profile.key.toBase58()} className="bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg">
                            <div className="flex justify-between items-start mb-4">
                                <div>
                                    <h3 className="text-xl font-semibold text-blue-400">Profile: <span className="text-sm font-mono text-gray-300">{profile.key.toBase58()}</span></h3>
                                    <p className="text-sm text-gray-400 mt-1">Created: {new Date(profile.data.createdAt.toNumber() * 1000).toLocaleDateString()}</p>
                                    <p className="text-sm text-gray-400">Auth Threshold: {profile.data.keyThreshold}</p>
                                </div>
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm text-gray-300">
                                    <thead className="bg-gray-900 text-xs uppercase text-gray-400">
                                        <tr>
                                            <th className="px-4 py-2 rounded-tl-lg">Key</th>
                                            <th className="px-4 py-2">Permissions</th>
                                            <th className="px-4 py-2">Expiry</th>
                                            <th className="px-4 py-2 rounded-tr-lg">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {profile.profileKeys.map((pk, idx) => {
                                            const perms = ProfilePermissions.fromPermissions(pk.permissions);
                                            const isAuth = perms.auth;
                                            const isMe = wallet.publicKey && pk.key.equals(wallet.publicKey);

                                            return (
                                                <tr key={`${profile.key.toBase58()}-${idx}`} className="hover:bg-gray-750 transition-colors">
                                                    <td className="px-4 py-3 font-mono">
                                                        {pk.key.toBase58()} 
                                                        {isMe && <span className="ml-2 text-xs bg-green-900 text-green-200 px-2 py-0.5 rounded-full">You</span>}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-wrap gap-1">
                                                            {isAuth && <span className="bg-red-900/50 text-red-200 px-2 py-0.5 rounded text-xs border border-red-900">Auth</span>}
                                                            {perms.addKeys && <span className="bg-blue-900/50 text-blue-200 px-2 py-0.5 rounded text-xs border border-blue-900">Add Keys</span>}
                                                            {perms.removeKeys && <span className="bg-yellow-900/50 text-yellow-200 px-2 py-0.5 rounded text-xs border border-yellow-900">Rm Keys</span>}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 text-gray-400">
                                                        {pk.expireTime.lt(new BN(0)) ? 'Never' : new Date(pk.expireTime.toNumber() * 1000).toLocaleDateString()}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {isAuth && isMe ? (
                                                            <button 
                                                                onClick={() => openTransferModal(profile)}
                                                                className="text-blue-400 hover:text-blue-300 text-xs uppercase font-bold tracking-wide disabled:opacity-50"
                                                                disabled={processing}
                                                            >
                                                                Transfer Auth
                                                            </button>
                                                        ) : (
                                                            !isAuth && (
                                                                <button 
                                                                    onClick={() => handleDeleteKey(profile, idx)}
                                                                    className="text-red-400 hover:text-red-300 text-xs uppercase font-bold tracking-wide disabled:opacity-50"
                                                                    disabled={processing}
                                                                >
                                                                    Delete
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

            {showTransferModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-800 p-6 rounded-xl max-w-lg w-full border border-gray-700 shadow-2xl">
                        {renderTransferModalContent()}
                    </div>
                </div>
            )}
        </div>
    );
};
