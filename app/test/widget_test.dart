import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:voicebridge/main.dart';

void main() {
  testWidgets('renders the disconnected state with no bridge configured',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const VoiceBridgeApp());
    await tester.pump();

    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.textContaining('disconnected'), findsOneWidget);
    expect(find.text('tap to talk'), findsOneWidget);
  });
}
