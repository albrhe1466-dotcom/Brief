package com.brief.desktop

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ChatUiMessage(
    val isUser: Boolean,
    val meta: String,
    val text: String
)

class MainActivity : AppCompatActivity() {
    private lateinit var vault: ApiKeyVault
    private val aiClient = BriefAiClient()
    private lateinit var agent: PhoneAgentRunner

    private lateinit var rootLayout: LinearLayout
    private lateinit var providerLogoImg: ImageView
    private lateinit var welcomeLogoImg: ImageView
    private lateinit var headerTitle: TextView
    private lateinit var headerSubtitle: TextView
    private lateinit var btnModeChat: TextView
    private lateinit var btnModeWork: TextView
    private lateinit var btnSettings: TextView
    private lateinit var permissionBanner: View
    private lateinit var permissionBannerText: TextView
    private lateinit var btnOpenSetupFromBanner: TextView
    private lateinit var welcomeContainer: View
    private lateinit var welcomeHeading: TextView
    private lateinit var messagesRecycler: RecyclerView
    private lateinit var liveStatusBar: View
    private lateinit var liveStatusText: TextView
    private lateinit var btnStopRun: TextView
    private lateinit var promptInput: EditText
    private lateinit var btnPickModel: TextView
    private lateinit var btnThinkingLevel: TextView
    private lateinit var btnClearChat: TextView
    private lateinit var btnSend: TextView

    private val messages = mutableListOf<ChatUiMessage>()
    private lateinit var adapter: MessagesAdapter

    private var isWorkMode = false
    private var isRunning = false
    private var setupDialog: AlertDialog? = null

    private val screenCapLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val svc = Intent(this, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc)
            } else {
                startService(svc)
            }
            Toast.makeText(this, "Live screen vision enabled!", Toast.LENGTH_SHORT).show()
        }
        refreshPermissionUi()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        vault = ApiKeyVault(this)
        agent = PhoneAgentRunner(this, aiClient, vault)

        bindViews()
        setupListeners()
        applyProviderTheme()
        refreshPermissionUi()

        if (!vault.hasKey(vault.getActiveProvider())) {
            openSetupDialog()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionUi()
    }

    private fun bindViews() {
        rootLayout = findViewById(R.id.rootLayout)
        providerLogoImg = findViewById(R.id.providerLogoImg)
        welcomeLogoImg = findViewById(R.id.welcomeLogoImg)
        headerTitle = findViewById(R.id.headerTitle)
        headerSubtitle = findViewById(R.id.headerSubtitle)
        btnModeChat = findViewById(R.id.btnModeChat)
        btnModeWork = findViewById(R.id.btnModeWork)
        btnSettings = findViewById(R.id.btnSettings)
        permissionBanner = findViewById(R.id.permissionBanner)
        permissionBannerText = findViewById(R.id.permissionBannerText)
        btnOpenSetupFromBanner = findViewById(R.id.btnOpenSetupFromBanner)
        welcomeContainer = findViewById(R.id.welcomeContainer)
        welcomeHeading = findViewById(R.id.welcomeHeading)
        messagesRecycler = findViewById(R.id.messagesRecycler)
        liveStatusBar = findViewById(R.id.liveStatusBar)
        liveStatusText = findViewById(R.id.liveStatusText)
        btnStopRun = findViewById(R.id.btnStopRun)
        promptInput = findViewById(R.id.promptInput)
        btnPickModel = findViewById(R.id.btnPickModel)
        btnThinkingLevel = findViewById(R.id.btnThinkingLevel)
        btnClearChat = findViewById(R.id.btnClearChat)
        btnSend = findViewById(R.id.btnSend)

        adapter = MessagesAdapter(messages)
        messagesRecycler.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        messagesRecycler.adapter = adapter
    }

    private fun setupListeners() {
        btnModeChat.setOnClickListener { setWorkMode(false) }
        btnModeWork.setOnClickListener { setWorkMode(true) }
        btnSettings.setOnClickListener { openSetupDialog() }
        btnOpenSetupFromBanner.setOnClickListener { openSetupDialog() }
        findViewById<TextView>(R.id.btnNewChatWelcome).setOnClickListener { openSetupDialog() }
        findViewById<TextView>(R.id.btnSampleResearch).setOnClickListener {
            promptInput.setText("Search the web for today's top tech news and summarize clearly.")
        }

        btnThinkingLevel.setOnClickListener {
            val next = vault.getThinkingLevel().next()
            vault.setThinkingLevel(next)
            btnThinkingLevel.text = next.label
        }

        btnPickModel.setOnClickListener { showModelPicker() }
        btnClearChat.setOnClickListener {
            if (!isRunning) {
                agent.reset()
                messages.clear()
                adapter.notifyDataSetChanged()
                welcomeContainer.visibility = View.VISIBLE
                messagesRecycler.visibility = View.GONE
            }
        }

        btnStopRun.setOnClickListener {
            agent.stop()
            liveStatusText.text = "Stopping…"
        }

        btnSend.setOnClickListener { sendCurrentPrompt() }
    }

    private fun setWorkMode(work: Boolean) {
        isWorkMode = work
        applyModeButtons()
        refreshPermissionUi()
    }

    private fun applyModeButtons() {
        val prov = vault.getActiveProvider()
        val accent = prov.accentColorHex.toInt()
        if (isWorkMode) {
            btnModeWork.background = GradientDrawable().apply { setColor(accent); cornerRadius = 999f }
            btnModeWork.setTextColor(0xFFFFFFFF.toInt())
            btnModeChat.background = null
            btnModeChat.setTextColor(0xFF94A3B8.toInt())
            promptInput.hint = "Give Brief a phone task (open app, research, tap)…"
        } else {
            btnModeChat.background = GradientDrawable().apply { setColor(accent); cornerRadius = 999f }
            btnModeChat.setTextColor(0xFFFFFFFF.toInt())
            btnModeWork.background = null
            btnModeWork.setTextColor(0xFF94A3B8.toInt())
            promptInput.hint = "Ask Brief anything or research live…"
        }
    }

    private fun applyProviderTheme() {
        val prov = vault.getActiveProvider()
        val bg = when (prov) {
            ProviderId.GEMINI -> 0xFF0E0E10.toInt()
            ProviderId.OPENAI -> 0xFF080808.toInt()
            ProviderId.ANTHROPIC -> 0xFF212120.toInt()
            ProviderId.OPENROUTER -> 0xFF0B0D15.toInt()
        }
        rootLayout.setBackgroundColor(bg)
        window.statusBarColor = bg
        window.navigationBarColor = bg

        val logoRes = when (prov) {
            ProviderId.GEMINI -> R.drawable.ic_gemini_logo
            ProviderId.OPENAI -> R.drawable.ic_openai_logo
            ProviderId.ANTHROPIC -> R.drawable.ic_claude_logo
            ProviderId.OPENROUTER -> R.drawable.ic_openrouter_logo
        }
        providerLogoImg.setImageResource(logoRes)
        welcomeLogoImg.setImageResource(logoRes)
        headerTitle.text = if (prov == ProviderId.OPENROUTER) "OpenRouter · Brief" else "Brief · ${prov.displayName}"
        welcomeHeading.text = if (prov == ProviderId.ANTHROPIC) "Back at it" else "Where should we begin?"

        btnSend.background = GradientDrawable().apply {
            setColor(prov.accentColorHex.toInt())
            shape = GradientDrawable.OVAL
        }

        val modelId = vault.getActiveModel(prov)
        val preset = ProviderModels.presetsFor(prov).firstOrNull { it.id == modelId }
        btnPickModel.text = ((preset?.label ?: modelId).take(18)) + " ▾"
        btnThinkingLevel.text = vault.getThinkingLevel().label
        applyModeButtons()
    }

    private fun refreshPermissionUi() {
        val overlayOk = CursorOverlayService.canDrawOverlays(this)
        val accOk = BriefAccessibilityService.isEnabled(this)
        val screenOk = ScreenCaptureService.isReady()
        permissionBanner.visibility = if (isWorkMode && (!overlayOk || !accOk)) View.VISIBLE else View.GONE
        headerSubtitle.text = when {
            isWorkMode && overlayOk && accOk && screenOk -> "Work Ready · Cursor + Vision"
            isWorkMode && overlayOk && accOk -> "Work Ready · Tap Setup for Vision"
            isWorkMode -> "Turn on Setup Permissions"
            else -> "Android · Research & Control"
        }

        setupDialog?.let { dlg ->
            dlg.findViewById<TextView>(R.id.txtOverlayStatus)?.text =
                if (overlayOk) "Granted ✓ Floating provider cursor enabled" else "Needed so you can see Brief's cursor over every app"
            dlg.findViewById<TextView>(R.id.btnGrantOverlay)?.text = if (overlayOk) "Granted ✓" else "Allow"

            dlg.findViewById<TextView>(R.id.txtAccessibilityStatus)?.text =
                if (accOk) "Granted ✓ Zero-root taps & typing enabled" else "Needed so Brief can tap, swipe & open apps without root"
            dlg.findViewById<TextView>(R.id.btnGrantAccessibility)?.text = if (accOk) "Enabled ✓" else "Enable"

            dlg.findViewById<TextView>(R.id.txtScreenCapStatus)?.text =
                if (screenOk) "Active ✓ Screen vision streaming cleanly" else "Optional: lets Brief see screenshots alongside UI tree"
            dlg.findViewById<TextView>(R.id.btnGrantScreenCap)?.text = if (screenOk) "Active ✓" else "Share"
        }
    }

    private fun showModelPicker() {
        val prov = vault.getActiveProvider()
        val presets = ProviderModels.presetsFor(prov)
        val labels = presets.map { "${it.label} · ${it.hint}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("${prov.displayName} Models")
            .setItems(labels) { _, which ->
                val picked = presets[which]
                vault.setActiveModel(prov, picked.id)
                applyProviderTheme()
            }
            .show()
    }

    private fun sendCurrentPrompt() {
        if (isRunning) return
        val text = promptInput.text.toString().trim()
        if (text.isEmpty()) return

        val prov = vault.getActiveProvider()
        if (!vault.hasKey(prov)) {
            openSetupDialog()
            return
        }

        promptInput.setText("")
        welcomeContainer.visibility = View.GONE
        messagesRecycler.visibility = View.VISIBLE

        messages.add(ChatUiMessage(true, "You", text))
        adapter.notifyItemInserted(messages.size - 1)
        messagesRecycler.scrollToPosition(messages.size - 1)

        isRunning = true
        liveStatusBar.visibility = View.VISIBLE
        liveStatusText.text = if (isWorkMode) "Starting phone work…" else "Thinking…"

        val work = isWorkMode
        lifecycleScope.launch {
            val reply = withContext(Dispatchers.IO) {
                agent.runUserMessage(text, work) { step ->
                    runOnUiThread { liveStatusText.text = step }
                }
            }
            isRunning = false
            liveStatusBar.visibility = View.GONE
            messages.add(ChatUiMessage(false, "${prov.displayName} · Brief", reply))
            adapter.notifyItemInserted(messages.size - 1)
            messagesRecycler.scrollToPosition(messages.size - 1)
        }
    }

    private fun openSetupDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_setup, null)
        val dlg = AlertDialog.Builder(this)
            .setView(view)
            .create()
        setupDialog = dlg

        var selectedProv = vault.getActiveProvider()
        val tabs = mapOf(
            ProviderId.GEMINI to view.findViewById<TextView>(R.id.tabProvGemini),
            ProviderId.OPENAI to view.findViewById<TextView>(R.id.tabProvOpenAi),
            ProviderId.ANTHROPIC to view.findViewById<TextView>(R.id.tabProvClaude),
            ProviderId.OPENROUTER to view.findViewById<TextView>(R.id.tabProvOpenRouter)
        )
        val txtKeyStatus = view.findViewById<TextView>(R.id.txtKeyStatus)
        val inputApiKey = view.findViewById<EditText>(R.id.inputApiKey)

        fun paintTabs() {
            for ((p, tv) in tabs) {
                val active = (p == selectedProv)
                tv.background = GradientDrawable().apply {
                    setColor(if (active) p.accentColorHex.toInt() else 0xFF191F30.toInt())
                    cornerRadius = 999f
                }
                val savedMark = if (vault.hasKey(p)) " ✓" else ""
                tv.text = p.displayName + savedMark
                tv.setTextColor(if (active) 0xFFFFFFFF.toInt() else 0xFF94A3B8.toInt())
            }
            txtKeyStatus.text = if (vault.hasKey(selectedProv)) {
                "Encrypted key saved for ${selectedProv.displayName}."
            } else {
                "Paste your ${selectedProv.displayName} API key above."
            }
        }
        paintTabs()

        for ((p, tv) in tabs) {
            tv.setOnClickListener {
                selectedProv = p
                if (vault.hasKey(p)) {
                    vault.setActiveProvider(p)
                    applyProviderTheme()
                }
                paintTabs()
            }
        }

        view.findViewById<TextView>(R.id.btnVerifySaveKey).setOnClickListener {
            val rawKey = inputApiKey.text.toString().trim()
            if (rawKey.isEmpty()) {
                txtKeyStatus.text = "Please paste an API key first."
                return@setOnClickListener
            }
            val detected = ProviderId.detectFromKey(rawKey)
            selectedProv = detected
            paintTabs()
            txtKeyStatus.text = "Verifying ${detected.displayName} key…"
            lifecycleScope.launch {
                val (ok, msg) = withContext(Dispatchers.IO) { aiClient.validateAndSetup(detected, rawKey) }
                if (ok) {
                    vault.saveKey(detected, rawKey)
                    inputApiKey.setText("")
                    applyProviderTheme()
                    paintTabs()
                    txtKeyStatus.text = msg
                } else {
                    txtKeyStatus.text = msg
                }
            }
        }

        view.findViewById<TextView>(R.id.btnSaveNameOnly).setOnClickListener {
            vault.clearKey(selectedProv)
            paintTabs()
            txtKeyStatus.text = "Cleared ${selectedProv.displayName} key."
        }

        view.findViewById<TextView>(R.id.btnGrantOverlay).setOnClickListener {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
        }

        view.findViewById<TextView>(R.id.btnGrantAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        view.findViewById<TextView>(R.id.btnGrantScreenCap).setOnClickListener {
            val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            screenCapLauncher.launch(mgr.createScreenCaptureIntent())
        }

        view.findViewById<TextView>(R.id.txtSamsungHelp).setOnClickListener {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
            startActivity(intent)
        }

        view.findViewById<TextView>(R.id.btnCloseSetup).setOnClickListener {
            dlg.dismiss()
        }

        dlg.setOnDismissListener {
            if (setupDialog === dlg) setupDialog = null
        }
        dlg.show()
        refreshPermissionUi()
    }

    private class MessagesAdapter(private val items: List<ChatUiMessage>) :
        RecyclerView.Adapter<MessagesAdapter.VH>() {

        class VH(itemView: View, val user: Boolean) : RecyclerView.ViewHolder(itemView)

        override fun getItemViewType(position: Int): Int = if (items[position].isUser) 1 else 0

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val inf = LayoutInflater.from(parent.context)
            return if (viewType == 1) {
                VH(inf.inflate(R.layout.item_message_user, parent, false), true)
            } else {
                VH(inf.inflate(R.layout.item_message_assistant, parent, false), false)
            }
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val msg = items[position]
            if (holder.user) {
                holder.itemView.findViewById<TextView>(R.id.msgUserText).text = msg.text
            } else {
                holder.itemView.findViewById<TextView>(R.id.msgMeta).text = msg.meta
                holder.itemView.findViewById<TextView>(R.id.msgAssistantText).text = msg.text
            }
        }
    }
}
