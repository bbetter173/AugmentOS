import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import {
  TpaConnectionInit,
  DataStream,
  DisplayRequest,
  TpaSubscriptionUpdate,
  TpaToCloudMessageType,
  StreamType,
  CloudToGlassesMessageType,
  CloudToTpaMessageType,
  ViewType,
  LayoutType,
  ExtendedStreamType,
  createTranslationStream,
} from '@augmentos/sdk';
import { languageToLocale } from '@augmentos/utils';
import { systemApps, CLOUD_PORT, CLOUD_HOST } from '@augmentos/config';
import axios from 'axios';

const app = express();
const PORT = systemApps.liveTranslation.port;
const PACKAGE_NAME = systemApps.liveTranslation.packageName;
const API_KEY = 'test_key'; // In production, this would be securely stored

// Track active sessions
const activeSessions = new Map<string, WebSocket>();
const userLanguageSettings = new Map<string, { source: string, target: string }>();

// Parse JSON bodies
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, './public')));

// Handle webhook call from AugmentOS Cloud
app.post('/webhook', async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    console.log(`\n\n🌍🌍🌍 Received session request for user ${userId}, session ${sessionId}\n\n`);

    // Start WebSocket connection to cloud
    const ws = new WebSocket(`ws://${CLOUD_HOST}:${CLOUD_PORT}/tpa-ws`);

    ws.on('open', async () => {
      console.log(`\n[Session ${sessionId}]\n connected to augmentos-cloud\n`);
      // Send connection init with session ID
      const initMessage: TpaConnectionInit = {
        type: TpaToCloudMessageType.CONNECTION_INIT,
        sessionId,
        packageName: PACKAGE_NAME,
        apiKey: API_KEY
      };
      ws.send(JSON.stringify(initMessage));

      // Set default language settings if not already set
      if (!userLanguageSettings.has(userId)) {
        userLanguageSettings.set(userId, {
          source: 'en-US',
          target: 'es-ES'
        });
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(sessionId, userId, ws, message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      console.log(`Session ${sessionId} disconnected`);
      activeSessions.delete(sessionId);
    });

    activeSessions.set(sessionId, ws);

    res.status(200).json({ status: 'connecting' });
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function handleMessage(sessionId: string, userId: string, ws: WebSocket, message: any) {
  switch (message.type) {
    case CloudToTpaMessageType.CONNECTION_ACK: {
      // Connection acknowledged, subscribe to translation
      const langSettings = userLanguageSettings.get(userId);
      
      if (langSettings) {
        const translationStream = createTranslationStream(langSettings.source, langSettings.target);
        
        const subMessage: TpaSubscriptionUpdate = {
          type: TpaToCloudMessageType.SUBSCRIPTION_UPDATE,
          packageName: PACKAGE_NAME,
          sessionId,
          subscriptions: [translationStream as ExtendedStreamType]
        };
        ws.send(JSON.stringify(subMessage));
        console.log(`Session ${sessionId} connected and subscribed to ${translationStream}`);
      }
      break;
    }

    case CloudToTpaMessageType.DATA_STREAM: {
      const streamMessage = message as DataStream;
      if (streamMessage.streamType === StreamType.TRANSLATION) {
        handleTranslation(sessionId, userId, ws, streamMessage.data);
      }
      break;
    }

    default:
      console.log('Unknown message type:', message.type);
  }
}

function handleTranslation(sessionId: string, userId: string, ws: WebSocket, translationData: any) {
  // Process translation data
  const translatedText = translationData.text;
  const sourceLanguage = translationData.sourceLanguage;
  const targetLanguage = translationData.targetLanguage;
  
  console.log(`[Session ${sessionId}]: Received translation from ${sourceLanguage} to ${targetLanguage}`);
  console.log(`[Session ${sessionId}]: ${translatedText}`);
  
  // Display the translation
  const displayRequest: DisplayRequest = {
    type: TpaToCloudMessageType.DISPLAY_REQUEST,
    view: ViewType.MAIN,
    packageName: PACKAGE_NAME,
    sessionId,
    layout: {
      layoutType: LayoutType.TEXT_WALL,
      text: translatedText
    },
    timestamp: new Date(),
    durationMs: 10000 // 10 seconds
  };

  ws.send(JSON.stringify(displayRequest));
}

// Add a route to set language preferences
app.post('/settings', (req, res) => {
  try {
    const { userIdForSettings, sourceLanguage, targetLanguage } = req.body;
    
    if (!userIdForSettings || !sourceLanguage || !targetLanguage) {
      return res.status(400).json({ error: 'Missing userId, sourceLanguage, or targetLanguage' });
    }
    
    // Update language settings
    userLanguageSettings.set(userIdForSettings, {
      source: languageToLocale(sourceLanguage),
      target: languageToLocale(targetLanguage)
    });
    
    // Update subscription for all active sessions for this user
    for (const [sessionId, ws] of activeSessions.entries()) {
      // Here you would need to determine if this session belongs to the user
      // For simplicity, we'll just update all sessions
      const langSettings = userLanguageSettings.get(userIdForSettings);
      
      if (langSettings && ws.readyState === WebSocket.OPEN) {
        const translationStream = createTranslationStream(langSettings.source, langSettings.target);
        
        const subMessage: TpaSubscriptionUpdate = {
          type: TpaToCloudMessageType.SUBSCRIPTION_UPDATE,
          packageName: PACKAGE_NAME,
          sessionId,
          subscriptions: [translationStream as ExtendedStreamType]
        };
        ws.send(JSON.stringify(subMessage));
      }
    }
    
    res.json({ status: 'Settings updated successfully' });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Internal server error updating settings' });
  }
});

// Add a route to verify the server is running
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', app: PACKAGE_NAME });
});

app.listen(PORT, () => {
  console.log(`${PACKAGE_NAME} server running at http://localhost:${PORT}`);
}); 