import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: kBg,
  ));
  runApp(const VoiceBridgeApp());
}

// Build-time defaults so a debug APK can be pointed at a running bridge.
// Override with --dart-define=VB_TOKEN=... VB_HOST=... VB_PORT=...
const String kDefaultHost = String.fromEnvironment('VB_HOST', defaultValue: '127.0.0.1');
const int kDefaultPort = int.fromEnvironment('VB_PORT', defaultValue: 8765);
const String kDefaultToken = String.fromEnvironment('VB_TOKEN', defaultValue: '');

// Gray, white, black. Nothing else.
const Color kBg = Color(0xFF0B0B0C);
const Color kPanel = Color(0xFF161617);
const Color kLine = Color(0xFF2A2A2C);
const Color kText = Color(0xFFF2F2F2);
const Color kMuted = Color(0xFF8A8A8E);

class VoiceBridgeApp extends StatelessWidget {
  const VoiceBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VoiceBridge',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kBg,
        colorScheme: const ColorScheme.dark(
          surface: kBg,
          primary: kText,
          secondary: kMuted,
        ),
        useMaterial3: true,
      ),
      home: const BridgeScreen(),
    );
  }
}

// ---------------------------------------------------------------- transport

class TranscriptEntry {
  TranscriptEntry(this.role, this.text) : at = DateTime.now();
  final String role;
  final String text;
  final DateTime at;
}

class BridgeClient extends ChangeNotifier {
  String host = '127.0.0.1';
  int port = 8765;
  String token = '';

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  int _attempt = 0;

  bool connected = false;
  String lastError = '';
  String agentState = 'idle';
  String agentDetail = '';
  String injector = 'absent';
  final List<TranscriptEntry> transcript = [];

  void Function(String text, String priority)? onSay;
  void Function(String question, String askId)? onListen;

  String get endpoint => 'ws://$host:$port/ws?token=$token';

  Future<void> configure({required String host, required int port, required String token}) async {
    this.host = host;
    this.port = port;
    this.token = token;
    await _close();
    _attempt = 0;
    connect();
  }

  Future<void> connect() async {
    if (token.isEmpty) {
      lastError = 'no token';
      notifyListeners();
      return;
    }
    _retry?.cancel();
    await _close();

    try {
      final channel = IOWebSocketChannel.connect(
        Uri.parse(endpoint),
        connectTimeout: const Duration(seconds: 6),
      );
      await channel.ready;
      _channel = channel;
      connected = true;
      lastError = '';
      _attempt = 0;
      notifyListeners();

      _sub = channel.stream.listen(
        _onData,
        onDone: _onDrop,
        onError: (Object err) {
          lastError = err.toString();
          _onDrop();
        },
        cancelOnError: true,
      );

      send('hello', {
        'deviceName': 'android',
        'appVersion': '1.0.0',
        'protocolVersion': 1,
      });
    } catch (err) {
      lastError = err.toString().replaceFirst('WebSocketChannelException: ', '');
      _onDrop();
    }
  }

  void _onDrop() {
    connected = false;
    _channel = null;
    notifyListeners();
    _retry?.cancel();

    final seconds = math.min(8, math.pow(2, _attempt)).toDouble();
    _attempt = math.min(_attempt + 1, 5);
    _retry = Timer(Duration(milliseconds: (seconds * 1000).round()), connect);
  }

  void _onData(dynamic raw) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final type = msg['type'] as String? ?? '';
    final payload = (msg['payload'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

    switch (type) {
      case 'hello_ok':
        connected = true;
        injector = payload['injector'] as String? ?? injector;
        break;
      case 'say':
        final text = payload['text'] as String? ?? '';
        addRemote('agent', text);
        onSay?.call(text, payload['priority'] as String? ?? 'normal');
        break;
      case 'listen':
        final question = payload['question'] as String? ?? '';
        final askId = payload['askId'] as String? ?? '';
        addRemote('agent', question);
        onListen?.call(question, askId);
        break;
      case 'status':
        agentState = payload['state'] as String? ?? agentState;
        agentDetail = payload['detail'] as String? ?? '';
        break;
      case 'transcript':
        addRemote(
          payload['role'] as String? ?? 'system',
          payload['text'] as String? ?? '',
          dedupe: true,
        );
        break;
      case 'error':
        lastError = payload['code'] as String? ?? 'error';
        break;
    }
    notifyListeners();
  }

  void addRemote(String role, String text, {bool dedupe = false}) {
    if (text.isEmpty) return;
    if (dedupe && transcript.any((e) => e.text == text && e.role == role)) return;
    transcript.add(TranscriptEntry(role, text));
    if (transcript.length > 200) transcript.removeAt(0);
    notifyListeners();
  }

  void send(String type, Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null) return;
    channel.sink.add(jsonEncode({
      'v': 1,
      'id': 'app_${DateTime.now().microsecondsSinceEpoch}',
      'type': type,
      'ts': DateTime.now().millisecondsSinceEpoch,
      'payload': payload,
    }));
  }

  Future<void> _close() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _channel?.sink.close();
    } catch (_) {
      // already closed
    }
    _channel = null;
  }

  @override
  void dispose() {
    _retry?.cancel();
    _close();
    super.dispose();
  }
}

// ----------------------------------------------------------------------- ui

class BridgeScreen extends StatefulWidget {
  const BridgeScreen({super.key});

  @override
  State<BridgeScreen> createState() => _BridgeScreenState();
}

class _BridgeScreenState extends State<BridgeScreen> {
  final BridgeClient _client = BridgeClient();
  final FlutterTts _tts = FlutterTts();
  final stt.SpeechToText _speech = stt.SpeechToText();

  bool _sttReady = false;
  bool _listening = false;
  bool _speaking = false;
  bool _muted = false;
  String _partial = '';
  String _host = '127.0.0.1';
  int _port = 8765;
  String _token = '';

  @override
  void initState() {
    super.initState();
    _client.addListener(() {
      if (mounted) setState(() {});
    });
    _client.onSay = _handleSay;
    _client.onListen = _handleListen;
    _bootUp();
  }

  Future<void> _bootUp() async {
    final prefs = await SharedPreferences.getInstance();
    _host = prefs.getString('host') ?? kDefaultHost;
    _port = prefs.getInt('port') ?? kDefaultPort;
    _token = prefs.getString('token') ?? kDefaultToken;
    if (mounted) setState(() {});

    try {
      // Some devices ship Google TTS but leave tts_default_synth unset, which
      // makes speak() report success while nothing is audible. Select the
      // engine explicitly when it is present.
      final engines = await _tts.getEngines;
      if (engines is List && engines.isNotEmpty) {
        final names = engines.map((e) => e.toString()).toList();
        final google = names.firstWhere(
          (n) => n.contains('com.google.android.tts'),
          orElse: () => '',
        );
        if (google.isNotEmpty) {
          await _tts.setEngine(google);
          debugPrint('VOICEBRIDGE_TTS selected engine $google');
        }
      }

      await _tts.setLanguage('en-US');
      await _tts.setSpeechRate(0.5);
      await _tts.setPitch(1.0);
      await _tts.awaitSpeakCompletion(false);
      _tts.setCompletionHandler(() {
        if (mounted) setState(() => _speaking = false);
      });
      _tts.setCancelHandler(() {
        if (mounted) setState(() => _speaking = false);
      });
      _tts.setErrorHandler((msg) {
        debugPrint('VOICEBRIDGE_TTS error: $msg');
        _note('speech engine error: $msg');
      });

      final languages = await _tts.getLanguages;
      debugPrint('VOICEBRIDGE_TTS languages=$languages');
    } catch (e) {
      debugPrint('VOICEBRIDGE_TTS init failed: $e');
      _note('no speech engine: $e');
    }

    await _client.configure(host: _host, port: _port, token: _token);
  }

  Future<void> _speak(String text, {bool interrupt = false}) async {
    if (_muted || text.isEmpty) return;
    if (interrupt) {
      await _tts.stop();
    }
    setState(() => _speaking = true);
    try {
      final result = await _tts.speak(text);
      debugPrint('VOICEBRIDGE_TTS speak result=$result');
      if (result == 0) {
        setState(() => _speaking = false);
        _note('speech engine rejected the text');
      }
    } catch (e) {
      setState(() => _speaking = false);
      debugPrint('VOICEBRIDGE_TTS speak threw: $e');
      _note('speech failed: $e');
    }
  }

  void _note(String text) {
    if (!mounted) return;
    _client.addRemote('system', text);
  }

  Future<void> _handleSay(String text, String priority) async {
    await _speak(text, interrupt: priority == 'high');
  }

  Future<void> _handleListen(String question, String askId) async {
    await _speak(question);
    await _startListening(askId: askId);
  }

  Future<void> _startListening({String? askId}) async {
    if (!_sttReady) {
      _sttReady = await _speech.initialize(
        onError: (err) {
          if (mounted) setState(() => _listening = false);
        },
        onStatus: (status) {
          if (!mounted) return;
          if (status == 'done' || status == 'notListening') {
            setState(() => _listening = false);
          }
        },
      );
      if (!_sttReady) {
        _snack('Speech recognition is not available on this device.');
        return;
      }
    }

    setState(() {
      _listening = true;
      _partial = '';
    });

    await _speech.listen(
      onResult: (result) {
        if (!mounted) return;
        setState(() => _partial = result.recognizedWords);
        if (result.finalResult) {
          _finishUtterance(result.recognizedWords, askId: askId);
        }
      },
      listenOptions: stt.SpeechListenOptions(
        partialResults: true,
        cancelOnError: true,
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 3),
      ),
    );
  }

  Future<void> _stopListening() async {
    await _speech.stop();
    if (mounted) setState(() => _listening = false);
  }

  void _finishUtterance(String text, {String? askId}) {
    final trimmed = text.trim();
    setState(() {
      _listening = false;
      _partial = '';
    });
    if (trimmed.isEmpty) return;

    _client.addRemote('you', trimmed);
    if (askId != null) {
      _client.send('answer', {'forId': askId, 'text': trimmed});
    } else {
      _client.send('speech', {'text': trimmed});
    }
  }

  Future<void> _interrupt() async {
    await _tts.stop();
    await _speech.stop();
    setState(() {
      _speaking = false;
      _listening = false;
    });
    _client.send('interrupt', {'reason': 'app_interrupt'});
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(
        content: Text(message),
        backgroundColor: kPanel,
        behavior: SnackBarBehavior.floating,
      ));
  }

  Future<void> _openSettings() async {
    final hostController = TextEditingController(text: _host);
    final portController = TextEditingController(text: _port.toString());
    final tokenController = TextEditingController(text: _token);

    final saved = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: kPanel,
      isScrollControlled: true,
      builder: (context) => Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: MediaQuery.of(context).viewInsets.bottom + 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Connection',
                style: TextStyle(color: kText, fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            const Text(
              'Run scripts/connect-phone.sh on the PC, then paste the token from `node pc/bin/vb.js token`.',
              style: TextStyle(color: kMuted, fontSize: 12),
            ),
            const SizedBox(height: 16),
            _field(hostController, 'host'),
            const SizedBox(height: 10),
            _field(portController, 'port', keyboard: TextInputType.number),
            const SizedBox(height: 10),
            _field(tokenController, 'token', obscure: true),
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.pop(context, false),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: kMuted,
                      side: const BorderSide(color: kLine),
                    ),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    style: FilledButton.styleFrom(
                      backgroundColor: kText,
                      foregroundColor: kBg,
                    ),
                    child: const Text('Connect'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () async {
                await _client.connect();
              },
              child: const Text('Retry now', style: TextStyle(color: kMuted)),
            ),
          ],
        ),
      ),
    );

    if (saved != true) return;
    final prefs = await SharedPreferences.getInstance();
    _host = hostController.text.trim();
    _port = int.tryParse(portController.text.trim()) ?? 8765;
    _token = tokenController.text.trim();
    await prefs.setString('host', _host);
    await prefs.setInt('port', _port);
    await prefs.setString('token', _token);
    await _client.configure(host: _host, port: _port, token: _token);
    if (mounted) setState(() {});
  }

  Widget _field(TextEditingController controller, String hint,
      {TextInputType? keyboard, bool obscure = false}) {
    return TextField(
      controller: controller,
      keyboardType: keyboard,
      obscureText: obscure,
      style: const TextStyle(color: kText),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: kMuted),
        filled: true,
        fillColor: kBg,
        enabledBorder: const OutlineInputBorder(
          borderSide: BorderSide(color: kLine),
          borderRadius: BorderRadius.all(Radius.circular(10)),
        ),
        focusedBorder: const OutlineInputBorder(
          borderSide: BorderSide(color: kMuted),
          borderRadius: BorderRadius.all(Radius.circular(10)),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _client.dispose();
    _tts.stop();
    _speech.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final client = _client;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _header(client),
            _statusBar(client),
            const Divider(height: 1, color: kLine),
            Expanded(child: _transcript(client)),
            _controls(client),
          ],
        ),
      ),
    );
  }

  Widget _header(BridgeClient client) {
    final online = client.connected;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 10, 10),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: online ? kText : kMuted,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            online ? 'USB · connected' : 'USB · disconnected',
            style: const TextStyle(color: kText, fontSize: 13, letterSpacing: 0.2),
          ),
          const Spacer(),
          IconButton(
            onPressed: _openSettings,
            icon: const Icon(Icons.tune, size: 20, color: kMuted),
            tooltip: 'Connection settings',
          ),
        ],
      ),
    );
  }

  Widget _statusBar(BridgeClient client) {
    final detail = client.agentDetail;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: kPanel,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: kLine),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  client.agentState.toUpperCase(),
                  style: const TextStyle(
                    color: kText,
                    fontSize: 11,
                    letterSpacing: 1.2,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 180),
                    child: Text(
                      detail,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 11),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const Spacer(),
          if (client.injector == 'absent' && client.connected)
            const Text('queue mode',
                style: TextStyle(color: kMuted, fontSize: 11)),
        ],
      ),
    );
  }

  Widget _transcript(BridgeClient client) {
    if (client.transcript.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Text(
            client.connected
                ? 'Hold the circle and speak.\nYour words are typed into the agent\'s input box.'
                : 'Not connected.\nRun the USB tunnel, then open settings and paste the token.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: kMuted, fontSize: 13, height: 1.6),
          ),
        ),
      );
    }

    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
      itemCount: client.transcript.length,
      itemBuilder: (context, index) {
        final entry = client.transcript[client.transcript.length - 1 - index];
        final mine = entry.role == 'you';
        return Align(
          alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.78,
            ),
            decoration: BoxDecoration(
              color: mine ? kText : kPanel,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: mine ? kText : kLine),
            ),
            child: Text(
              entry.text,
              style: TextStyle(
                color: mine ? kBg : kText,
                fontSize: 14,
                height: 1.35,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _controls(BridgeClient client) {
    final active = _listening;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 22),
      child: Column(
        children: [
          if (_partial.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                _partial,
                textAlign: TextAlign.center,
                style: const TextStyle(color: kMuted, fontSize: 13),
              ),
            ),
          if (_speaking)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('speaking', style: TextStyle(color: kMuted, fontSize: 12)),
                  const SizedBox(width: 10),
                  GestureDetector(
                    onTap: _interrupt,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        border: Border.all(color: kLine),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Text('stop',
                          style: TextStyle(color: kText, fontSize: 12)),
                    ),
                  ),
                ],
              ),
            ),
          GestureDetector(
            onTapDown: (_) => _startListening(),
            onTapUp: (_) async {
              await Future<void>.delayed(const Duration(milliseconds: 600));
              if (_listening) await _stopListening();
            },
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              width: active ? 92 : 84,
              height: active ? 92 : 84,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: active ? kText : kPanel,
                border: Border.all(color: active ? kText : kLine, width: 1.4),
              ),
              child: Icon(
                active ? Icons.graphic_eq : Icons.mic_none,
                color: active ? kBg : kText,
                size: 30,
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            _listening ? 'listening — tap to send' : 'tap to talk',
            style: const TextStyle(color: kMuted, fontSize: 11, letterSpacing: 0.4),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TextButton(
                onPressed: () {
                  setState(() => _muted = !_muted);
                  if (_muted) _tts.stop();
                },
                child: Text(
                  _muted ? 'unmute' : 'mute',
                  style: const TextStyle(color: kMuted, fontSize: 12),
                ),
              ),
              const SizedBox(width: 4),
              TextButton(
                onPressed: _interrupt,
                child: const Text('interrupt',
                    style: TextStyle(color: kMuted, fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
