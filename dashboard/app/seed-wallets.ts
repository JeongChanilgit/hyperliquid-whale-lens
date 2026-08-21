export type SeedWallet = {
  address: string;
  label: string;
  screenedReturnPct: number;
  status: "ACTIVE" | "PASS";
};

// ACTIVE: hash-linked simulation-only exact-TWR cohort with at least one raw 30D fill.
// PASS: exact-TWR evidence/watchlist rows retained for trading analysis only.
// Run `npm run data:sync-trade-qualified` after regenerating account-preservation rescue evidence.
export const SEED_WALLETS: SeedWallet[] = [
  { address: "0x7933481da364d5cc3151c22154a0295703765ac9", label: "Trade-qualified TWR 01", screenedReturnPct: 175.86577637, status: "ACTIVE" },
  { address: "0xa45ee34298f8e5596fef0870a42f80182de0cfb9", label: "Trade-qualified TWR 02", screenedReturnPct: 132.86433119, status: "ACTIVE" },
  { address: "0x15a4f009bb324a3fb9e36137136b201e3fe0dfdb", label: "Trade-qualified TWR 03", screenedReturnPct: 117.01169366, status: "ACTIVE" },
  { address: "0xb64460b8f4a2f521b815a209f053d35fb1977d51", label: "Trade-qualified TWR 04", screenedReturnPct: 89.22578882, status: "ACTIVE" },
  { address: "0x8804e9fda107be1424e355f5e2652b559d150df6", label: "Trade-qualified TWR 05", screenedReturnPct: 75.87995445, status: "ACTIVE" },
  { address: "0xcec62a8b313740495cc2d6f5728f2f978fea715f", label: "Trade-qualified TWR 06", screenedReturnPct: 69.40559608, status: "ACTIVE" },
  { address: "0x1dacfab213f593420639805d6f697f992eeb2430", label: "Trade-qualified TWR 07", screenedReturnPct: 69.34122707, status: "ACTIVE" },
  { address: "0x48080441105eff197da409c154608c3e9021a82c", label: "Trade-qualified TWR 08", screenedReturnPct: 68.40391515, status: "ACTIVE" },
  { address: "0x639c8d8744f66b1cf9ff9a5776d92b9e498a9aa9", label: "Trade-qualified TWR 09", screenedReturnPct: 50.94428927, status: "ACTIVE" },
  { address: "0xf8b5bde5f6aa989c01754931e077e1e5a915e2bb", label: "Trade-qualified TWR 10", screenedReturnPct: 47.28561724, status: "ACTIVE" },
  { address: "0x06e9dcb5b833b6a797261585c65a9a056f553fcb", label: "Verified TWR Watch 11", screenedReturnPct: 42.77259426, status: "PASS" },
  { address: "0xf82a238e4916f8045a8f82aa639bb530a02ef78b", label: "Verified TWR Watch 12", screenedReturnPct: 40.41874182, status: "PASS" },
  { address: "0xdcc3d8c92bd463232a494b12a40913cbeea64237", label: "Verified TWR Watch 13", screenedReturnPct: 40.31117975, status: "PASS" },
  { address: "0xcf903fc632733d5453ee12cb92b56dc22fcb5bd1", label: "Verified TWR Watch 14", screenedReturnPct: 39.56344238, status: "PASS" },
  { address: "0x27c0cfee4f037ce4f455c1ecd566210d4c82a8bc", label: "Verified TWR Watch 15", screenedReturnPct: 35.08345912, status: "PASS" },
  { address: "0xa9ee565e1c412f04419edd20ea64aa8324a290b2", label: "Verified TWR Watch 16", screenedReturnPct: 33.09470642, status: "PASS" },
  { address: "0x2c00c005a9f67fe9a9a6182daa8c601d3dbb9ce2", label: "Verified TWR Watch 17", screenedReturnPct: 31.86519453, status: "PASS" },
  { address: "0xc88d0c6be07270617aa9fc920137344f7839de36", label: "Verified TWR Watch 18", screenedReturnPct: 30.22189857, status: "PASS" },
  { address: "0xe4be02d34bfa56815bb3fb0ab6308d67d3409b76", label: "Verified TWR Watch 19", screenedReturnPct: 25.07326374, status: "PASS" },
  { address: "0xfaf4d68bbb12be9178f5ce5e9e6def947c611f83", label: "Verified TWR Watch 20", screenedReturnPct: 24.40505809, status: "PASS" },
  { address: "0x0d98c3747252127196318e96195f996aa326bde6", label: "Verified TWR Watch 21", screenedReturnPct: 23.81213763, status: "PASS" },
  { address: "0x7118a73bcb88a485ecd6174a841dcbd2752fc21f", label: "Verified TWR Watch 22", screenedReturnPct: 23.76523289, status: "PASS" },
  { address: "0x0c5ba524dd2e2453e63cda7fe2b9c8755ca0f5c9", label: "Verified TWR Watch 23", screenedReturnPct: 22.16709454, status: "PASS" },
  { address: "0x9a88dd4eacc3aa561c4f50ec66bcede831bec813", label: "Verified TWR Watch 24", screenedReturnPct: 21.13331450, status: "PASS" },
  { address: "0x426ffa99039c971b8074bf468142f684d4bef6f6", label: "Verified TWR Watch 25", screenedReturnPct: 20.92581721, status: "PASS" },
  { address: "0x24d8969e2bd6aabb6c4dfe042ef8b2cd8085217e", label: "Verified TWR Watch 26", screenedReturnPct: 20.73230589, status: "PASS" },
  { address: "0xddde1879a13ff291fd67c5c13764f9d25f96437a", label: "Verified TWR Watch 27", screenedReturnPct: 19.23527019, status: "PASS" },
  { address: "0xe330ac756dabf22466317a01f5d1e9baa00e77a1", label: "Verified TWR Watch 28", screenedReturnPct: 17.85520801, status: "PASS" },
  { address: "0x1261aa209c8fca040870bbb29ab8377fb778c022", label: "Verified TWR Watch 29", screenedReturnPct: 17.11680075, status: "PASS" },
  { address: "0x8cae4c475672eb3646f4e2962decfd33bf8f022a", label: "Verified TWR Watch 30", screenedReturnPct: 17.05286051, status: "PASS" },
  { address: "0x253b88ebaa7c321d4803c0cfaf708684e3de32be", label: "Verified TWR Watch 31", screenedReturnPct: 11.89022511, status: "PASS" },
  { address: "0x545600d21b903e83736b807268011f39c4e1ffbb", label: "Verified TWR Watch 32", screenedReturnPct: 11.73322301, status: "PASS" },
  { address: "0x35f13dc71426d4a429cf8bad69c4b39abbbf9896", label: "Verified TWR Watch 33", screenedReturnPct: 11.41727378, status: "PASS" },
  { address: "0x2a9c628f9b1b06a881407ae457ffb0e51fb7e752", label: "Verified TWR Watch 34", screenedReturnPct: 250.64489177, status: "PASS" },
  { address: "0x9eb4348964d9943fc8579734d1a6e2fb2d88c83e", label: "Verified TWR Watch 35", screenedReturnPct: 172.08053402, status: "PASS" },
  { address: "0x8f82a25b060a1cb272ae72749a11c278ab2ae960", label: "Verified TWR Watch 36", screenedReturnPct: 135.11450969, status: "PASS" },
  { address: "0x912b578140ed52f98122f6aeca7a03147a0175ce", label: "Verified TWR Watch 37", screenedReturnPct: 123.52903467, status: "PASS" },
  { address: "0xbe714a04c08195e691e4f772bc41ff51255fe86a", label: "Verified TWR Watch 38", screenedReturnPct: 118.12711056, status: "PASS" },
  { address: "0x52c912aa379242a2dab2c555703a78c573e650ba", label: "Verified TWR Watch 39", screenedReturnPct: 115.65225805, status: "PASS" },
  { address: "0x1cbabf5cae040215ab7e8204a741191c04a4a24f", label: "Verified TWR Watch 40", screenedReturnPct: 111.82726169, status: "PASS" },
  { address: "0x9df6bda43fd897bf1be8b87841f6e6f89c9f5490", label: "Verified TWR Watch 41", screenedReturnPct: 104.32927925, status: "PASS" },
  { address: "0x85d5aaf6fb4224f39745b0a8a399b59f49026eb9", label: "Verified TWR Watch 42", screenedReturnPct: 101.57013798, status: "PASS" },
  { address: "0x0d11c704be32a6a296bc5d0a18f707c22be01ba4", label: "Verified TWR Watch 43", screenedReturnPct: 101.05991245, status: "PASS" },
  { address: "0xbcd116e374752c6da3385ad482e9b67b85a2b2fc", label: "Verified TWR Watch 44", screenedReturnPct: 92.90375445, status: "PASS" },
  { address: "0xba87b6cfa4d7e32dafc4434db086b068efb2550a", label: "Verified TWR Watch 45", screenedReturnPct: 90.71244086, status: "PASS" },
  { address: "0xda8ea935b53bb538e3b4c404f953462cc27e7a7c", label: "Verified TWR Watch 46", screenedReturnPct: 89.77390889, status: "PASS" },
  { address: "0x627d83dfec9a60f66a4bb0b851a39c263c20be9c", label: "Verified TWR Watch 47", screenedReturnPct: 89.17862696, status: "PASS" },
  { address: "0xa3504e77b0c7e91e4133f39a6896983e418a411f", label: "Verified TWR Watch 48", screenedReturnPct: 89.07873547, status: "PASS" },
  { address: "0xfc0743f19c3507fe9db805865327ed3fcf425968", label: "Verified TWR Watch 49", screenedReturnPct: 88.36947040, status: "PASS" },
  { address: "0xd417b1a16270effdc2ec9f8973a29c61d734f11d", label: "Verified TWR Watch 50", screenedReturnPct: 84.43313569, status: "PASS" },
];
