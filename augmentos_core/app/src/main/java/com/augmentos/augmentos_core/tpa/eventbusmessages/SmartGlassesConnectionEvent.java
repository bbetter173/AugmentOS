package com.augmentos.augmentos_core.tpa.eventbusmessages;

public class SmartGlassesConnectionEvent {
    public final int connectionStatus;

    public SmartGlassesConnectionEvent(int connectionStatus) {
        this.connectionStatus = connectionStatus;
    }
}