/**
 * 🎯 TPA Session Module
 * 
 * Manages an active Third Party App session with AugmentOS Cloud.
 * Handles real-time communication, event subscriptions, and display management.
 */
import WebSocket from 'ws';
import { EventManager } from './events';
import { LayoutManager } from './layouts';
import type {
  StreamType,
  TpaToCloudMessage,
  CloudToTpaMessage,
  TpaConnectionInitMessage,
  TpaSubscriptionUpdateMessage,
  TranscriptionData,
  HeadPositionEvent,
  ButtonPressEvent,
  PhoneNotificationEvent,
  AppSettings
} from '@augmentos/types';

/**
 * ⚙️ Configuration options for TPA Session
 * 
 * @example
 * ```typescript
 * const config: TpaSessionConfig = {
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key',
 *   autoReconnect: true
 * };
 * ```
 */
export interface TpaSessionConfig {
  /** 📦 Unique identifier for your TPA (e.g., 'org.company.appname') */
  packageName: string;
  /** 🔑 API key for authentication with AugmentOS Cloud */
  apiKey: string;
  /** 🔌 WebSocket server URL (default: 'ws://localhost:7002/tpa-ws') */
  serverUrl?: string;
  /** 🔄 Automatically attempt to reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** 🔁 Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** ⏱️ Base delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number;
}

/**
 * 🚀 TPA Session Implementation
 * 
 * Manages a live connection between your TPA and AugmentOS Cloud.
 * Provides interfaces for:
 * - 🎮 Event handling (transcription, head position, etc.)
 * - 📱 Display management in AR view
 * - 🔌 Connection lifecycle
 * - 🔄 Automatic reconnection
 * 
 * @example
 * ```typescript
 * const session = new TpaSession({
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key'
 * });
 * 
 * // Handle events
 * session.onTranscription((data) => {
 *   session.layouts.showTextWall(data.text);
 * });
 * 
 * // Connect to cloud
 * await session.connect('session_123');
 * ```
 */
export class TpaSession {
  /** WebSocket connection to AugmentOS Cloud */
  private ws: WebSocket | null = null;
  /** Current session identifier */
  private sessionId: string | null = null;
  /** Number of reconnection attempts made */
  private reconnectAttempts = 0;
  /** Active event subscriptions */
  private subscriptions = new Set<StreamType>();

  /** 🎮 Event management interface */
  public readonly events: EventManager;
  /** 📱 Layout management interface */
  public readonly layouts: LayoutManager;

  constructor(private config: TpaSessionConfig) {
    this.config = {
      serverUrl: 'ws://localhost:7002/tpa-ws',
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
      ...config
    };

    this.events = new EventManager(this.subscribe.bind(this));
    this.layouts = new LayoutManager(
      config.packageName,
      this.send.bind(this)
    );
  }

  // =====================================
  // 🎮 Direct Event Handling Interface
  // =====================================

  /**
   * 🎤 Listen for speech transcription events
   * @param handler - Function to handle transcription data
   * @returns Cleanup function to remove the handler
   */
  onTranscription(handler: (data: TranscriptionData) => void): () => void {
    return this.events.onTranscription(handler);
  }

  /**
   * 👤 Listen for head position changes
   * @param handler - Function to handle head position updates
   * @returns Cleanup function to remove the handler
   */
  onHeadPosition(handler: (data: HeadPositionEvent) => void): () => void {
    return this.events.onHeadPosition(handler);
  }

  /**
   * 🔘 Listen for hardware button press events
   * @param handler - Function to handle button events
   * @returns Cleanup function to remove the handler
   */
  onButtonPress(handler: (data: ButtonPressEvent) => void): () => void {
    return this.events.onButtonPress(handler);
  }

  /**
   * 📱 Listen for phone notification events
   * @param handler - Function to handle notifications
   * @returns Cleanup function to remove the handler
   */
  onPhoneNotifications(handler: (data: PhoneNotificationEvent) => void): () => void {
    return this.events.onPhoneNotifications(handler);
  }

  // =====================================
  // 📡 Pub/Sub Interface
  // =====================================

  /**
   * 📬 Subscribe to a specific event stream
   * @param type - Type of event to subscribe to
   */
  subscribe(type: StreamType): void {
    this.subscriptions.add(type);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.updateSubscriptions();
    }
  }

  /**
   * 🎯 Generic event listener (pub/sub style)
   * @param event - Event name to listen for
   * @param handler - Event handler function
   */
  on(event: string, handler: (data: any) => void): () => void {
    return this.events.onConnected(handler);
  }

  // =====================================
  // 🔌 Connection Management
  // =====================================

  /**
   * 🚀 Connect to AugmentOS Cloud
   * @param sessionId - Unique session identifier
   * @returns Promise that resolves when connected
   */
  async connect(sessionId: string): Promise<void> {
    this.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.serverUrl as string);

        this.ws.on('open', () => {
          this.sendConnectionInit();
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString()) as CloudToTpaMessage;
            this.handleMessage(message);
          } catch (error) {
            this.events.emit('error', new Error('Failed to parse message'));
          }
        });

        this.ws.on('close', () => {
          this.events.emit('disconnected', 'Connection closed');
          this.handleReconnection();
        });

        this.ws.on('error', (error) => {
          this.events.emit('error', error);
        });

        this.events.onConnected(() => resolve());

        // Connection timeout after 5 seconds
        setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 5000);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 👋 Disconnect from AugmentOS Cloud
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.sessionId = null;
    this.subscriptions.clear();
  }

  // =====================================
  // 🔧 Private Methods
  // =====================================

  /**
   * 📨 Handle incoming messages from cloud
   */
  private handleMessage(message: CloudToTpaMessage): void {
    switch (message.type) {
      case 'tpa_connection_ack':
        this.events.emit('connected', message.settings);
        this.updateSubscriptions();
        break;

      case 'tpa_connection_error':
        this.events.emit('error', new Error(message.message));
        break;

      case 'data_stream':
        this.events.emit(message.streamType, message.data);
        break;

      case 'settings_update':
        this.events.emit('settings_update', message.settings);
        break;
    }
  }

  /**
   * 🔐 Send connection initialization message
   */
  private sendConnectionInit(): void {
    const message: TpaConnectionInitMessage = {
      type: 'tpa_connection_init',
      sessionId: this.sessionId!,
      packageName: this.config.packageName,
      apiKey: this.config.apiKey
    };
    this.send(message);
  }

  /**
   * 📝 Update subscription list with cloud
   */
  private updateSubscriptions(): void {
    const message: TpaSubscriptionUpdateMessage = {
      type: 'subscription_update',
      packageName: this.config.packageName,
      subscriptions: Array.from(this.subscriptions)
    };
    this.send(message);
  }

  /**
   * 🔄 Handle reconnection with exponential backoff
   */
  private async handleReconnection(): Promise<void> {
    if (!this.config.autoReconnect ||
      !this.sessionId ||
      this.reconnectAttempts >= (this.config.maxReconnectAttempts || 5)) {
      return;
    }

    const delay = (this.config.reconnectDelay || 1000) * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connect(this.sessionId);
      this.reconnectAttempts = 0;
    } catch (error) {
      this.events.emit('error', new Error('Reconnection failed'));
    }
  }

  /**
   * 📤 Send message to cloud
   * @throws {Error} If WebSocket is not connected
   */
  private send(message: TpaToCloudMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }
}