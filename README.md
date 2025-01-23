# Eliza

## Edit the character files

Open `src/character.ts` to modify the default character. Uncomment and edit.

### Custom characters

To load custom characters instead:
- Use `ENABLE_ACTION_PROCESSING=true pnpm start --character="characters/eliza.character.json`
- Multiple character files can be loaded simultaneously

```
# Cache Configs
CACHE_STORE=database # Defaults to database. Other available cache store: redis and filesystem


# evm
EVM_PRIVATE_KEY=
EVM_PUBLIC_KEY=
WALLET_PUBLIC_KEY=
EVM_PROVIDER_URL=


ETERNAL_AI_LOG_REQUEST=false #Default: false


# ElevenLabs Settings
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TRANSCRIPTION_PROVIDER=local    # Can be 'local', 'openai', or 'deepgram'


# Twitter/X Configuration
TWITTER_DRY_RUN=false
TWITTER_USERNAME=           # Account username
TWITTER_PASSWORD=           # Account password
TWITTER_EMAIL=                # Account email
TWITTER_2FA_SECRET=
ENABLE_ACTION_PROCESSING=true
TWITTER_ENABLE_ACTION_PROCESSING=true
ACTION_INTERVAL=1

TWITTER_POLL_INTERVAL=120       # How often (in seconds) the bot should check for interactions
TWITTER_SEARCH_ENABLE=FALSE     # Enable timeline search, WARNING this greatly increases your chance of getting banned
TWITTER_TARGET_USERS=0x_Sero           # Comma separated list of Twitter user names to interact with
TWITTER_RETRY_LIMIT="1"            # Maximum retry attempts for Twitter login
TWITTER_SPACES_ENABLE=false     # Enable or disable Twitter Spaces logic

# Twitter action processing configuration
ENABLE_ACTION_PROCESSING=false   # Set to true to enable the action processing loop
        # Default: gpt-4o
# Anthropic Configuration
ANTHROPIC_API_KEY=             # For Claude


# Solana Configuration
SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
BASE_MINT=So11111111111111111111111111111111111111112
RPC_URL=https://api.mainnet-beta.solana.com

# Server Configuration
SERVER_PORT=3000


ABSTRACT_RPC_URL=https://api.testnet.abs.xyz


# Intiface Configuration
INTIFACE_WEBSOCKET_URL=ws://localhost:12345

# Farcaster Neynar Configuration
  # Signer for the account you are sending casts from. Create a signer here: https://dev.neynar.com/app
FARCASTER_DRY_RUN=false         # Set to true if you want to run the bot without actually publishing casts
FARCASTER_POLL_INTERVAL=120     # How often (in seconds) the bot should check for farcaster interactions (replies and mentions)


# Coinbase Charity Configuration
IS_CHARITABLE=false   # Set to true to enable charity donations
CHARITY_ADDRESS_BASE=0x1234567890123456789012345678901234567890
CHARITY_ADDRESS_SOL=pWvDXKu6CpbKKvKQkZvDA66hgsTB6X2AgFxksYogHLV
CHARITY_ADDRESS_ETH=0x750EF1D7a0b4Ab1c97B7A623D7917CcEb5ea779C
CHARITY_ADDRESS_ARB=0x1234567890123456789012345678901234567890
CHARITY_ADDRESS_POL=0x1234567890123456789012345678901234567890


# TEE_MODE options:
# - LOCAL: Uses simulator at localhost:8090 (for local development)
# - DOCKER: Uses simulator at host.docker.internal:8090 (for docker development)
# - PRODUCTION: No simulator, uses production endpoints
# Defaults to OFF if not specified
TEE_MODE=OFF                    # LOCAL | DOCKER | PRODUCTION

# Galadriel Configuration
GALADRIEL_API_KEY=gal-*         # Get from https://dashboard.galadriel.com/


WHATSAPP_API_VERSION=v17.0      # WhatsApp API version (default: v17.0)


# EchoChambers Configuration
ECHOCHAMBERS_API_URL=http://127.0.0.1:3333
ECHOCHAMBERS_API_KEY=testingkey0011
ECHOCHAMBERS_USERNAME=eliza
ECHOCHAMBERS_DEFAULT_ROOM=general
ECHOCHAMBERS_POLL_INTERVAL=60
ECHOCHAMBERS_MAX_MESSAGES=10


SLIPPAGE=1
RPC_URL=https://rpc.testnet.near.org
NEAR_NETWORK=testnet # or mainnet
```

bare minimum to .env set up put this .env in twitter-client & root

then run pnpm start --character="characters/esther.character.json"

once you tag the bot or reply to one of it's tweets with a transfer request

### Add clients

```diff
- clients: [],
+ clients: [Clients.TWITTER, Clients.DISCORD],
```

## Duplicate the .env.example template

```bash
cp .env.example .env
```

\* Fill out the .env file with your own values.

### Add login credentials and keys to .env

```diff
-DISCORD_APPLICATION_ID=
-DISCORD_API_TOKEN= # Bot token
+DISCORD_APPLICATION_ID="000000772361146438"
+DISCORD_API_TOKEN="OTk1MTU1NzcyMzYxMT000000.000000.00000000000000000000000000000000"
...
-OPENROUTER_API_KEY=
+OPENROUTER_API_KEY="sk-xx-xx-xxx"
...
-TWITTER_USERNAME= # Account username
-TWITTER_PASSWORD= # Account password
-TWITTER_EMAIL= # Account email
+TWITTER_USERNAME="username"
+TWITTER_PASSWORD="password"
+TWITTER_EMAIL="your@email.com"
```

## Install dependencies and start your agent

```bash
pnpm i && pnpm start
```
Note: this requires node to be at least version 22 when you install packages and run the agent.
