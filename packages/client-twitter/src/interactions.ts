import { SearchMode, type Tweet } from "agent-twitter-client";
import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  type State,
  stringToUuid,
  elizaLogger,
  getEmbeddingZeroVector,
  type IImageDescriptionService,
  ServiceType,
} from "@elizaos/core";
import { Action } from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils";

export const twitterMessageHandlerTemplate =
  `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
  `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  private isDryRun: boolean;
  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
  }

  async start() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        // Defaults to 2 minutes
        this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000,
      );
    };
    handleTwitterInteractionsLoop();
  }

  /**
 * Processes a batch of tweets, handling rate limiting and concurrent processing
 * @param tweets Array of tweets to process
 */
private async processTweets(tweets: Tweet[]): Promise<void> {
    const processedIds = new Set<string>();
    const processingPromises: Promise<void>[] = [];

    for (const tweet of tweets) {
        // Skip if already processed
        if (!tweet.id || this.isProcessed(tweet)) {
            continue;
        }

        try {
            // Build thread and create memory
            const thread = await buildConversationThread(tweet, this.client, 1);
            const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
            const userId = stringToUuid(tweet.userId!);

            // Ensure connections exist
            await this.runtime.ensureConnection(
                userId,
                roomId,
                tweet.username,
                tweet.name,
                "twitter"
            );

            const message: Memory = {
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                content: { text: tweet.text || "" },
                agentId: this.runtime.agentId,
                userId,
                roomId,
                createdAt: tweet.timestamp! * 1000,
                embedding: []
            };

            // Process tweet with rate limiting
            const processPromise = this.handleTweet({ tweet, message, thread })
                .then(() => {
                    this.client.markTweetProcessed(tweet.id!);
                    this.updateLastProcessedId(tweet.id!);
                })
                .catch(error => {
                    elizaLogger.error("Error processing tweet:", {
                        error,
                        tweetId: tweet.id
                    });
                });

            processingPromises.push(processPromise);

            // Basic rate limiting
            if (processingPromises.length >= 5) {
                await Promise.all(processingPromises);
                processingPromises.length = 0;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await this.updateLastProcessedId(tweet.id);
        } catch (error) {
            elizaLogger.error("Error setting up tweet processing:", {
                error,
                tweetId: tweet.id
            });
        }
    }

    // Wait for any remaining promises
    await Promise.all(processingPromises);
}

/**
 * Main interaction handler for Twitter processing
 * Manages tweet fetching, filtering, and processing
 */
async handleTwitterInteractions(): Promise<void> {
    elizaLogger.log("Starting Twitter interactions check");
    
    if (!this.client.profile?.username) {
        elizaLogger.error("No profile username available");
        return;
    }

    try {
        // Get mentions
        const mentionCandidates = (
            await this.client.fetchSearchTweets(
                `@${this.client.profile.username}`,
                20,
                SearchMode.Latest
            )
        ).tweets;

        // Get target user tweets if configured
        const targetUserTweets = await this.fetchTargetUserTweets();

        // Combine and filter tweets
        const uniqueTweetCandidates = this.deduplicateTweets([
            ...mentionCandidates,
            ...targetUserTweets
        ]);

        // Process valid tweets
        const validTweets = uniqueTweetCandidates.filter((tweet: Tweet) => 
            this.isValidTweet(tweet) && 
            this.isWithinTimeWindow(tweet) &&
            !this.isProcessed(tweet)
        );

        // Sort by ID and process
        const sortedTweets = validTweets.sort((a: Tweet, b: Tweet) => {
            if (!a.id || !b.id) return 0;
            return a.id.localeCompare(b.id)
        }
        );

        await this.processTweets(sortedTweets);

        elizaLogger.log("Completed Twitter interactions check", {
            processed: sortedTweets.length,
            total: uniqueTweetCandidates.length
        });

    } catch (error) {
        elizaLogger.error("Failed to handle Twitter interactions:", error);
    }
}

  /**
 * Generates and sends a response to a tweet with proper error handling
 * @param message - The original message/memory
 * @param state - Current state for response generation
 * @param replyToTweetId - ID of tweet to reply to
 * @returns The sent response content
 */
private async generateAndSendResponse(
    message: Memory,
    state: State,
    replyToTweetId: string
): Promise<Content | null> {
    try {
        // Generate response using message handler template
        const context = composeContext({
            state,
            template: this.runtime.character.templates?.twitterMessageHandlerTemplate
                || this.runtime.character?.templates?.messageHandlerTemplate || ''
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        // Clean up response text
        response.text = this.cleanResponseText(response.text);
        response.inReplyTo = stringToUuid(replyToTweetId + "-" + this.runtime.agentId);

        if (!response.text) {
            elizaLogger.warn("Empty response generated", { messageId: message.id });
            return null;
        }

        // Send tweet via callback
        const callback: HandlerCallback = async (response: Content) => {
            const memories = await sendTweet(
                this.client,
                response,
                message.roomId,
                this.client.twitterConfig.TWITTER_USERNAME,
                replyToTweetId
            );
            return memories;
        };

        const responseMemories = await callback(response);

        // Update state and store memories
        state = await this.runtime.updateRecentMessageState(state);

        for (const responseMemory of responseMemories) {
            if (responseMemory === responseMemories[responseMemories.length - 1]) {
                responseMemory.content.action = response.action;
            } else {
                responseMemory.content.action = "CONTINUE";
            }
            await this.runtime.messageManager.createMemory(responseMemory);
        }

        return response;

    } catch (error) {
        elizaLogger.error("Error generating/sending response:", {
            error,
            messageId: message.id,
            replyToTweetId
        });
        return null;
    }
}

/**
 * Update and cache the last processed tweet ID
 * @param tweetId - ID of the most recently processed tweet
 */
private async updateLastProcessedId(tweetId: string): Promise<void> {
    try {
        const numericId = BigInt(tweetId);
        if (!this.client.lastCheckedTweetId || numericId > this.client.lastCheckedTweetId) {
            this.client.lastCheckedTweetId = numericId;
            await this.client.cacheLatestCheckedTweetId();
            elizaLogger.debug("Updated last processed tweet ID:", tweetId);
        }
    } catch (error) {
        elizaLogger.error("Error updating last processed ID:", {
            error,
            tweetId
        });
    }
}

/**
 * Fetch tweets from configured target users
 * @returns Array of tweets from target users
 */
private async fetchTargetUserTweets(): Promise<Tweet[]> {
    const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
    if (!targetUsers?.length) {
        return [];
    }

    const targetTweets: Tweet[] = [];
    elizaLogger.log("Fetching tweets from target users:", targetUsers);

    for (const username of targetUsers) {
        try {
            const userTweets = (
                await this.client.twitterClient.fetchSearchTweets(
                    `from:${username}`,
                    3,
                    SearchMode.Latest
                )
            ).tweets;

            const validTweets = userTweets.filter(tweet => 
                !tweet.isReply && 
                !tweet.isRetweet && 
                this.isWithinTimeWindow(tweet)
            );

            if (validTweets.length > 0) {
                // Randomly select one tweet from each user
                const randomTweet = validTweets[Math.floor(Math.random() * validTweets.length)];
                targetTweets.push(randomTweet);
                elizaLogger.debug(`Selected tweet from ${username}:`, {
                    tweetId: randomTweet.id,
                    text: randomTweet.text?.substring(0, 100)
                });
            }
        } catch (error) {
            elizaLogger.error(`Error fetching tweets for ${username}:`, error);
        }
    }

    return targetTweets;
}

/**
 * Remove duplicate tweets from combined tweet arrays
 * @param tweets - Array of tweets to deduplicate
 * @returns Deduplicated array of tweets
 */
private deduplicateTweets(tweets: Tweet[]): Tweet[] {
    const seen = new Set<string>();
    return tweets.filter(tweet => {
        if (!tweet.id || seen.has(tweet.id)) {
            return false;
        }
        seen.add(tweet.id);
        return true;
    });
}

/**
 * Validate tweet structure and content
 * @param tweet - Tweet to validate
 * @returns boolean indicating if tweet is valid
 */
private isValidTweet(tweet: Tweet): boolean {
    return !!(
        tweet &&
        tweet.id &&
        tweet.text?.trim() &&
        tweet.userId &&
        tweet.username &&
        tweet.timestamp &&
        // Exclude self-tweets unless configured otherwise
        tweet.userId !== this.client.profile?.id
    );
}

/**
 * Check if tweet is within configured time window for processing
 * @param tweet - Tweet to check
 * @returns boolean indicating if tweet is within time window
 */
private isWithinTimeWindow(tweet: Tweet): boolean {
    const timeWindow = this.client.twitterConfig.TWITTER_TIME_WINDOW || 7200; // Default 2 hours
    const tweetAge = Date.now() - (tweet.timestamp! * 1000);
    return tweetAge < (timeWindow * 1000);
}

/**
 * Check if tweet has already been processed
 * @param tweet - Tweet to check
 * @returns boolean indicating if tweet has been processed
 */
private isProcessed(tweet: Tweet): boolean {
    // Check if tweet ID is older than last processed
    if (this.client.lastCheckedTweetId && 
        BigInt(tweet.id!) <= this.client.lastCheckedTweetId) {
        return true;
    }

    // Also check in-memory processed set
    return this.client.isTweetProcessed(tweet.id!);
}

/**
 * Caches interaction details for future reference and debugging
 * @param tweet - Original tweet
 * @param response - Generated response
 * @param state - Final state after processing
 */
private async cacheInteraction(
    tweet: Tweet,
    response: Content | null,
    state: State
): Promise<void> {
    try {
        // Cache the interaction context and response
        const interactionInfo = {
            timestamp: Date.now(),
            tweet: {
                id: tweet.id,
                text: tweet.text,
                author: tweet.username,
                createdAt: tweet.timestamp
            },
            response: response ? {
                text: response.text,
                action: response.action
            } : null,
            state: {
                action: (state.content as { action?: string })?.action || null,
                context: state.currentPost
            }
        };

        await this.runtime.cacheManager.set(
            `twitter/interaction_${tweet.id}.json`,
            interactionInfo,
            { expires: Date.now() + (7 * 24 * 60 * 60 * 1000) } // 7 days expiry
        );

        // If there was a response, also cache generation context
        if (response) {
            const responseInfo = {
                context: state,
                tweet: {
                    id: tweet.id,
                    author: tweet.username,
                    text: tweet.text
                },
                response: {
                    text: response.text,
                    action: response.action
                }
            };

            await this.runtime.cacheManager.set(
                `twitter/tweet_generation_${tweet.id}.txt`,
                JSON.stringify(responseInfo, null, 2)
            );
        }

    } catch (error) {
        elizaLogger.error("Error caching interaction:", {
            error,
            tweetId: tweet.id
        });
        // Non-critical error, don't throw
    }
}

/**
 * Helper function to clean response text
 * @param text - Raw response text
 * @returns Cleaned text
 */
private cleanResponseText(text: string): string {
    return text
        .replace(/^['"](.*)['"]$/, "$1") // Remove surrounding quotes
        .replace(/\\n/g, "\n") // Handle newlines
        .trim();
}

  /**
   * Handles processing and response generation for individual tweets
   * Includes action detection, validation, and execution
   */
  private async handleTweet({
    tweet,
    message,
    thread,
  }: {
    tweet: Tweet;
    message: Memory;
    thread: Tweet[];
  }): Promise<void> {
    // Validate input data
    if (!tweet.text || !tweet.id || !tweet.userId || !tweet.timestamp) {
      elizaLogger.warn("Invalid tweet data, skipping", { tweetId: tweet.id });
      return;
    }

    // Skip self-tweets unless configured otherwise
    if (tweet.userId === this.client.profile!.id) {
      return;
    }

    elizaLogger.log("Processing tweet:", {
      id: tweet.id,
      text: tweet.text.substring(0, 100),
      author: tweet.username,
    });

    try {
      const formatTweet = (tweet: Tweet) => {
        return `  ID: ${tweet.id}
            From: ${tweet.name} (@${tweet.username})
            Text: ${tweet.text}`;
      };

      const formattedConversation = thread
        .map(
          (tweet) => `@${tweet.username} (${new Date(
            tweet.timestamp! * 1000,
          ).toLocaleString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            month: "short",
            day: "numeric",
          })}):
                ${tweet.text}`,
        )
        .join("\n\n");
      // Format tweet for context
      const currentPost = formatTweet(tweet);

      // Compose initial state
      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
        currentPost,
        formattedConversation,
      });

      // Get registered actions and validate them against tweet content
      const availableActions = this.runtime.actions;
      console.log('ACTIONS HERE', availableActions, this.runtime);
      const validActions = await Promise.all(
        availableActions.map(async (action) => {
          const isValid = await this.validateAction(tweet.text!, action, {
            tweet,
            thread,
          });
          return isValid ? action.name : null;
        }),
      );

      const detectedActions = validActions
        .filter((action): action is string => action !== null)
        .sort((a, b) => this.getActionPriority(b) - this.getActionPriority(a));

      // Process highest priority action if any detected
      if (detectedActions.length > 0) {
        message.content.action = detectedActions[0];
        const actionResult = await this.processAction(
          detectedActions[0],
          message,
          state,
        );

        if (!actionResult.success) {
          elizaLogger.error("Action processing failed:", actionResult.error);
        }

        // Update state with action result
        state = await this.runtime.updateRecentMessageState(state);
      }

      // Generate and send response
      const response = await this.generateAndSendResponse(
        message,
        state,
        tweet.id,
      );

      // Cache interaction details
      await this.cacheInteraction(tweet, response, state);
    } catch (error) {
      elizaLogger.error("Error handling tweet:", {
        error,
        tweetId: tweet.id,
        userId: tweet.userId,
      });
    }
  }
  /**
   * Processes a detected action with proper error handling and logging
   * @param action - The action to process
   * @param message - The message containing action context
   * @param state - Current state for action processing
   * @returns Result of action processing
   */
  private async processAction(
    action: string,
    message: Memory,
    state: State,
  ): Promise<{
    success: boolean;
    result?: any;
    error?: Error;
  }> {
    elizaLogger.log(`Processing action: ${action}`, {
      messageId: message.id,
      userId: message.userId,
    });

    try {
      // Get action priority and validate
      const priority = this.getActionPriority(action);
      if (priority < 0) {
        throw new Error(`Invalid action: ${action}`);
      }

      // Process the action through runtime
      const result = await this.runtime.processActions(
        message,
        [message],
        state,
      );

      // Log success
      elizaLogger.log(`Successfully processed action ${action}`, {
        messageId: message.id,
        result,
      });

      return {
        success: true,
        result,
      };
    } catch (error) {
      elizaLogger.error(`Failed to process action ${action}:`, error);
      return {
        success: false,
        error: error as Error,
      };
    }
  }

  /**
   * Determines the priority level for a given action
   * Higher priority actions are processed first
   * @param actionName - Name of the action to check
   * @returns priority level (higher number = higher priority), -1 if invalid
   */
  private getActionPriority(actionName: string): number {
    // Define priority levels for different action types
    const priorities: Record<string, number> = {
      TRANSFER: 100, // Highest priority for transfers
      BRIDGE: 90, // High priority for bridge operations
      SWAP: 80, // High priority for swaps
      SEND_TOKEN: 100, // Equivalent to transfer
      QUOTE: 50, // Medium priority
      LIKE: 30, // Lower priority
      RETWEET: 30, // Lower priority
      FOLLOW_ROOM: 20, // Low priority
      CONTINUE: 10, // Lowest priority
      IGNORE: 0, // Lowest priority
    };

    // Normalize action name
    const normalizedAction = actionName.toUpperCase();

    // Return priority or -1 if action not recognized
    return priorities[normalizedAction] ?? -1;
  }

  /**
   * Validates whether a given text contains action triggers and meets context requirements
   * @param text - The text to check for action triggers
   * @param actionConfig - The action configuration from runtime
   * @param context - Optional context data for validation
   * @returns boolean indicating if action is valid in this context
   */
  private async validateAction(
    text: string,
    actionConfig: Action,
    context?: Record<string, any>,
  ): Promise<boolean> {
    try {
      // Don't process empty text
      if (!text?.trim()) {
        return false;
      }

      // Create pattern set from action name and similes
      const patterns = [
        actionConfig.name.toLowerCase(),
        ...(actionConfig.similes || []).map((s) => s.toLowerCase()),
      ];

      const normalizedText = text.toLowerCase();
      const matchesPattern = patterns.some(
        (pattern) =>
          normalizedText.includes(pattern) ||
          new RegExp(`\\b${pattern}\\b`, "i").test(normalizedText),
      );

      // If no pattern match, early return
      if (!matchesPattern) {
        return false;
      }

      // If action has a custom validator, use it
      if (actionConfig.validate) {
        return await actionConfig.validate(this.runtime, {
          content: { text },
          userId: context?.tweet?.userId || stringToUuid('00000000-0000-0000-0000-000000000000'),
          agentId: this.runtime.agentId,
          roomId: context?.tweet?.conversationId ? stringToUuid(context.tweet.conversationId + "-" + this.runtime.agentId) : stringToUuid('00000000-0000-0000-0000-000000000000'),
          ...context,
        });
      }

      return true;
    } catch (error) {
      elizaLogger.error(`Error validating action ${actionConfig.name}:`, error);
      return false;
    }
  }

  async buildConversationThread(
    tweet: Tweet,
    maxReplies = 10,
  ): Promise<Tweet[]> {
    const thread: Tweet[] = [];
    const visited: Set<string> = new Set();
    const runtime = this.runtime;  // Capture this.runtime

    const processThread = async (currentTweet: Tweet, depth = 0) => {  // Convert to arrow function
      elizaLogger.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth: depth,
      });

      if (!currentTweet) {
        elizaLogger.log("No current tweet found for thread building");
        return;
      }

      if (depth >= maxReplies) {
        elizaLogger.log("Reached maximum reply depth", depth);
        return;
      }

      // Handle memory storage
      const memory = await runtime.messageManager.getMemoryById(  // Use captured runtime
        stringToUuid(currentTweet.id + "-" + runtime.agentId),  // Use captured runtime
      );
      if (!memory) {
        const roomId = stringToUuid(
          currentTweet.conversationId + "-" + this.runtime.agentId,
        );
        const userId = stringToUuid(currentTweet.userId!);

        await this.runtime.ensureConnection(
          userId,
          roomId,
          currentTweet.username,
          currentTweet.name,
          "twitter",
        );

        this.runtime.messageManager.createMemory({
          id: stringToUuid(currentTweet.id + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text!,
            source: "twitter",
            url: currentTweet.permanentUrl,
            imageUrls: currentTweet.photos?.map((photo) => photo.url) || [],
            inReplyTo: currentTweet.inReplyToStatusId
              ? stringToUuid(
                  currentTweet.inReplyToStatusId + "-" + this.runtime.agentId,
                )
              : undefined,
          },
          createdAt: currentTweet.timestamp! * 1000,
          roomId,
          userId:
            currentTweet.userId === this.client.profile?.id
              ? this.runtime.agentId
              : stringToUuid(currentTweet.userId!),
          embedding: getEmbeddingZeroVector(),
        });
      }

      if (visited.has(currentTweet.id!)) {
        elizaLogger.log("Already visited tweet:", currentTweet.id);
        return;
      }

      visited.add(currentTweet.id!);
      thread.unshift(currentTweet);

      if (currentTweet.inReplyToStatusId) {
        elizaLogger.log(
          "Fetching parent tweet:",
          currentTweet.inReplyToStatusId,
        );
        try {
          const parentTweet = await this.client.twitterClient.getTweet(
            currentTweet.inReplyToStatusId,
          );

          if (parentTweet) {
            elizaLogger.log("Found parent tweet:", {
              id: parentTweet.id,
              text: parentTweet.text?.slice(0, 50),
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger.log(
              "No parent tweet found for:",
              currentTweet.inReplyToStatusId,
            );
          }
        } catch (error) {
          elizaLogger.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error,
          });
        }
      } else {
        elizaLogger.log("Reached end of reply chain at:", currentTweet.id);
      }
    }

    // Need to bind this context for the inner function
    await processThread.bind(this)(tweet, 0);

    return thread;
  }
}
