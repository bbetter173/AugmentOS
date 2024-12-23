package com.teamopensmartglasses.augmentos_manager;

public class NewNotificationReceivedEvent {
    public String appName;
    public String title;
    public String text;

    public NewNotificationReceivedEvent(String appName, String title, String text){
        this.appName = appName;
        this.title = title;
        this.text = text;
    }
}
