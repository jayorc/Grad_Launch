Paste job URL
  -> job-routes.ts
  -> JobIntakeService.intakeFromUrl()
  -> save Job

Click fill browser
  -> application-routes.ts
  -> ApplicationService.fillJobInBrowser()
  -> prepare student/job/resume/profile fields
  -> BrowserAgentAdapterService.applyWithBrowser()
  -> BrowserAgentEngine.apply()

BrowserAgentEngine
  -> getAvailability()
  -> launchContext()
  -> openOrResumePage()
  -> navigateToJobPage()
  -> detectProtectedCheckpoint()

If login:
  -> waitForLoginConfirmation()
  -> user logs in manually
  -> user clicks continue
  -> re-check page

For each stage:
  -> discoverVisibleFields()
  -> observeBrowserPage()
  -> classifyPage()
  -> rankActions()
  -> buildStageExecutionPlan()

If upload:
  -> attachResume()

If fill:
  -> runAutonomousStageFill()
     -> buildStageAnswerPlan()
     -> fillFormField()
        -> resolveFillStrategy()
        -> fillByClassifiedControl()
        -> strategy-specific fill
     -> verifyFieldAnswer()
     -> verifyAndRepairKnownFields()

Then:
  -> getVisibleRequiredEmptyLabels()
  -> getVisibleValidationMessages()
  -> evaluateStageReadiness()
  -> reflectOnStageAnswers() if needed
  -> clickNextStageControl()
  -> repeat

End:
  -> stop at review/submit
  -> save receipt/checkpoint/screenshots/logs
