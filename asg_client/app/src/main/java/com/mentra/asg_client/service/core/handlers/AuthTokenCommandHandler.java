package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for authentication token commands.
 * Follows Single Responsibility Principle by handling only auth token commands.
 */
public class AuthTokenCommandHandler implements ICommandHandler {
    private static final String TAG = "AuthTokenCommandHandler";
    
    private final ICommunicationManager communicationManager;
    private final IConfigurationManager configurationManager;

    public AuthTokenCommandHandler(ICommunicationManager communicationManager, 
                                 IConfigurationManager configurationManager) {
        this.communicationManager = communicationManager;
        this.configurationManager = configurationManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("auth_token");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "auth_token":
                    return handleAuthToken(data);
                default:
                    Log.e(TAG, "Unsupported auth token command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling auth token command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle auth token command
     */
    private boolean handleAuthToken(JSONObject data) {
        try {
            final boolean hasCoreTokenField = data.has("coreToken");
            String coreToken = data.optString("coreToken", "");
            if (!hasCoreTokenField) {
                Log.e(TAG, "AUTH_TOKEN_SAVE_FAILED reason=missing_coreToken_field payload=" + data);
                communicationManager.sendTokenStatusResponse(false);
                return false;
            }

            if (coreToken.trim().isEmpty()) {
                Log.e(TAG, "AUTH_TOKEN_SAVE_FAILED reason=empty_coreToken_value");
                communicationManager.sendTokenStatusResponse(false);
                return false;
            }

            Log.d(TAG, "Received coreToken from AugmentOS Core (length=" + coreToken.length() + ")");
            boolean success = configurationManager.saveCoreToken(coreToken);
            String persistedToken = configurationManager.getCoreToken();
            boolean persistedMatches = persistedToken != null && persistedToken.equals(coreToken.trim());

            if (success && persistedMatches) {
                Log.i(TAG, "AUTH_TOKEN_SAVE_SUCCESS length=" + coreToken.length());
            } else if (!success) {
                Log.e(TAG, "AUTH_TOKEN_SAVE_FAILED reason=configuration_manager_save_returned_false");
            } else {
                int persistedLength = persistedToken == null ? -1 : persistedToken.length();
                Log.e(
                    TAG,
                    "AUTH_TOKEN_SAVE_FAILED reason=persisted_value_mismatch expectedLength="
                        + coreToken.trim().length() + " persistedLength=" + persistedLength
                );
            }

            communicationManager.sendTokenStatusResponse(success && persistedMatches);
            return success && persistedMatches;
        } catch (Exception e) {
            Log.e(TAG, "AUTH_TOKEN_SAVE_FAILED reason=exception_during_handle", e);
            communicationManager.sendTokenStatusResponse(false);
            return false;
        }
    }
} 