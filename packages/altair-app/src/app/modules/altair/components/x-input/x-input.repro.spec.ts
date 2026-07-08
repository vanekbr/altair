import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { mockStoreFactory } from '../../../../../testing';
import { XInputComponent } from './x-input.component';
import { EnvironmentService } from '../../services';
import { MockService } from 'ng-mocks';
import { EditorState } from '@codemirror/state';

describe('XInputComponent - Paste Bug Reproduction', () => {
  let component: XInputComponent;
  let fixture: ComponentFixture<XInputComponent>;

  beforeEach(async () => {
    const mockStore = mockStoreFactory();
    await TestBed.configureTestingModule({
      declarations: [XInputComponent],
      providers: [
        {
          provide: EnvironmentService,
          useValue: MockService(EnvironmentService),
        },
        {
          provide: Store,
          useValue: mockStore,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(XInputComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should only replace selected text when pasting, not the entire URL', () => {
    // Get the extensions which include the transaction filter
    const extensions = component.getExtensions();

    // Create an initial editor state with a URL
    const initialUrl = 'https://api.example.com/graphql';
    const initialState = EditorState.create({
      doc: initialUrl,
      extensions: extensions,
    });

    // Simulate selecting part of the URL (e.g., the path "/graphql")
    // Selection: from index 23 ("/") to end of URL (31)
    const selectedFrom = 23;
    const selectedTo = initialUrl.length;

    // Create a transaction that simulates a paste event
    // The user has selected "/graphql" and pastes "/new-endpoint"
    const pastedContent = '/new-endpoint';

    // Create a transaction with the paste change and mark it as a paste event
    const transaction = initialState.update({
      changes: {
        from: selectedFrom,
        to: selectedTo,
        insert: pastedContent,
      },
      userEvent: 'input.paste',
    });

    // Get the new document state after the transaction is processed
    const resultContent = transaction.newDoc.toString();

    // Expected: only the selected portion is replaced
    // "https://api.example.com/graphql" -> "https://api.example.com/new-endpoint"
    const expectedContent = 'https://api.example.com/new-endpoint';

    // Actual (with bug): the entire URL gets replaced with the new content
    // This is because the filterNewLine creates a change with from: 0
    // and inserts tr.newDoc.toString() (the entire new document)
    // which results in just the pasted content without the original prefix

    expect(resultContent).toBe(expectedContent);
  });
});
