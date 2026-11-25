package com.toby.satranc;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TobyOfflinePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
